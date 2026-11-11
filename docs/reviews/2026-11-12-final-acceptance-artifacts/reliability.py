"""用真实模型验收断观察、回执恢复、重复提交和精确取消。"""
import asyncio
import hashlib
import json
import secrets
import time
from urllib.parse import urlencode

import aiohttp


class ReliabilityFailure(Exception):
    def __init__(self, code):
        self.code = code


def input_statistics(events, client_id):
    inputs = []
    active = None
    turns = set()
    for event in events:
        if event.get('type') == 'session':
            active = None
        elif event.get('type') == 'turn/start':
            active = event.get('data', {}).get('turn')
        elif event.get('type') == 'user/message':
            data = event.get('data', {})
            message = data.get('message', data)
            if message.get('source', {}).get('rpcId') == client_id:
                inputs.append(message.get('id'))
                turns.add(data.get('turn', active))
    active = None
    headers = 0
    contexts = 0
    for event in events:
        if event.get('type') == 'session':
            active = None
        elif event.get('type') == 'turn/start':
            active = event.get('data', {}).get('turn')
        elif active in turns and event.get('type') == 'request/header':
            headers += 1
        elif active in turns and event.get('type') == 'request/context':
            contexts += 1
    return {'userInputCount': len(inputs), 'userMessageIds': inputs,
            'requestHeaderCount': headers, 'requestContextCount': contexts}


def receipt_identity(receipt):
    return {key: receipt.get(key) for key in ('generationId', 'conversationId', 'clientMessageId',
        'userMessageId', 'messageId', 'state', 'text', 'code')}


def receipt_summary(receipt):
    if not isinstance(receipt, dict):
        return {'present': False}
    text = receipt.get('text', '')
    return {key: receipt.get(key) for key in ('generationId', 'clientMessageId', 'userMessageId',
            'messageId', 'state', 'revision', 'code')} | {
            'textLength': len(text), 'textSha256': hashlib.sha256(text.encode()).hexdigest()}


async def run_reliability(*, args, client, origin, prefix, session_id, home, report,
                          record, launch, stop, synthetic_events):
    evidence = {'stage': 'recover-submit', 'queries': 0, 'submissions': [], 'cancelResponses': []}
    report['reliability'] = evidence
    session_route = f'/sessions/{session_id}'
    token = secrets.token_hex(5).upper()
    first_id = 'recovery-' + token
    cancel_id = 'cancel-' + token
    successor_id = 'successor-' + token

    def phase(name):
        evidence['stage'] = name

    def long_prompt(marker, lines):
        return (f'这是隔离的合成验收，不要调用任何工具。请严格逐行输出{lines}行，'
                f'每行格式为“{marker}_三位行号”，行号从001连续增加。'
                f'随后再单独输出“{marker}_END”。只输出要求的行，不要写解释，不要省略中间行。')

    async def request(method, route, body=None):
        async with client.request(method, origin + prefix + route, json=body) as response:
            data = await response.json()
            if response.status != 200:
                code = data.get('code')
                raise ReliabilityFailure(code if isinstance(code, str) else 'ADAPTER_HTTP_FAILED')
            return response.status, data

    async def generation(client_id, generation_id=None, previous=None, wait=False):
        query = {'clientMessageId': client_id}
        if generation_id is not None:
            query['generationId'] = generation_id
        if wait and isinstance(previous, dict) and isinstance(previous.get('revision'), int):
            query.update({'afterRevision': previous['revision'], 'waitMs': 2000})
        evidence['queries'] += 1
        _, data = await request('GET', session_route + '/generation?' + urlencode(query))
        return data.get('generation')

    async def await_terminal(client_id, generation_id):
        deadline = time.monotonic() + args.timeout
        previous = None
        changes = []
        while time.monotonic() < deadline:
            current = await generation(client_id, generation_id, previous, wait=previous is not None)
            if isinstance(current, dict):
                state = current.get('state')
                if not changes or changes[-1] != state:
                    changes.append(state)
                if state in ('completed', 'failed', 'cancelled'):
                    return current, changes
            previous = current
            if current is None:
                await asyncio.sleep(.2)
        evidence['lastObservedGeneration'] = receipt_summary(previous)
        raise ReliabilityFailure('GENERATION_TERMINAL_TIMEOUT')

    async def submit_observation(client_id, text, *, disconnect):
        evidence['submissions'].append({'clientMessageId': client_id, 'purpose': phase_name[0]})
        frames = []
        announced = None
        started = time.monotonic()
        async with client.post(origin + prefix + session_route + '/messages',
                json={'text': text, 'clientMessageId': client_id},
                timeout=aiohttp.ClientTimeout(total=args.timeout)) as response:
            if response.status != 200:
                data = await response.json()
                raise ReliabilityFailure(data.get('code', 'MESSAGE_HTTP_FAILED'))
            async for line in response.content:
                if not line.strip():
                    continue
                frame = json.loads(line)
                frames.append(frame)
                if frame.get('type') == 'generation':
                    announced = frame
                    if disconnect:
                        # 仅关闭观察连接，之后绝不重新提交原输入来猜测任务状态。
                        response.close()
                        return announced, frames, time.monotonic() - started
        return announced, frames, time.monotonic() - started

    async def native_ready(client_id, *, require_request=False):
        deadline = time.monotonic() + 8
        latest = None
        while time.monotonic() < deadline:
            latest = input_statistics(synthetic_events(home), client_id)
            if latest['userInputCount'] == 1 and (not require_request or latest['requestHeaderCount'] >= 1):
                return latest
            await asyncio.sleep(.1)
        return latest

    phase_name = ['disconnect-after-generation']
    first_marker = 'OAI_RECOVERY_' + token
    first_prompt = long_prompt(first_marker, 12)
    phase('recover-submit')
    announced, frames, elapsed = await submit_observation(first_id, first_prompt, disconnect=True)
    record('收到轮次身份后主动断开观察', isinstance(announced, dict)
           and isinstance(announced.get('generationId'), str),
           elapsedSeconds=round(elapsed, 3), frameTypes=[frame.get('type') for frame in frames],
           generationId=announced.get('generationId') if announced else None)
    first_generation = announced['generationId']
    phase('recover-reattach')
    reattach_before = await generation(first_id, first_generation)
    record('重附观察前原任务仍在运行', isinstance(reattach_before, dict)
           and reattach_before.get('state') == 'running', **receipt_summary(reattach_before))
    phase_name[0] = 'reattach-running-input'
    reattached = asyncio.create_task(submit_observation(first_id, first_prompt, disconnect=False))
    phase('recover-query')
    try:
        first_receipt, states = await await_terminal(first_id, first_generation)
        reattach_generation, reattach_frames, reattach_elapsed = await reattached
    finally:
        if not reattached.done():
            reattached.cancel()
            await asyncio.gather(reattached, return_exceptions=True)
    evidence['recoveredReceipt'] = first_receipt
    record('断观察后仅查询原轮次到真实完成', first_receipt.get('state') == 'completed'
           and first_marker + '_END' in first_receipt.get('text', '') and len(first_receipt.get('text', '')) >= 150,
           states=states, **receipt_summary(first_receipt))
    terminal_index = next((index for index, frame in enumerate(reattach_frames)
                           if frame.get('type') in ('done', 'error')), len(reattach_frames))
    delta_before_terminal = any(frame.get('type') == 'delta' and bool(frame.get('text'))
                               for frame in reattach_frames[:terminal_index])
    reattach_terminal = reattach_frames[terminal_index] if terminal_index < len(reattach_frames) else {}
    record('真实重附观察在终态前收到原任务增量', reattach_generation is not None
           and reattach_generation.get('generationId') == first_generation and delta_before_terminal
           and reattach_terminal.get('type') == 'done'
           and reattach_terminal.get('text') == first_receipt.get('text'),
           elapsedSeconds=round(reattach_elapsed, 3), deltaBeforeTerminal=delta_before_terminal,
           frameTypes=[frame.get('type') for frame in reattach_frames])
    before_replay = await native_ready(first_id, require_request=True)
    phase('completed-replay')
    phase_name[0] = 'duplicate-completed-input'
    replay_generation, replay_frames, replay_elapsed = await submit_observation(first_id, first_prompt, disconnect=False)
    replay_terminal = next((frame for frame in reversed(replay_frames) if frame.get('type') in ('done', 'error')), {})
    after_replay = await native_ready(first_id, require_request=True)
    record('相同客户端身份重复POST只重放原结果', replay_generation is not None
           and replay_generation.get('generationId') == first_generation and replay_terminal.get('type') == 'done'
           and replay_terminal.get('generationId') == first_generation
           and replay_terminal.get('userMessageId') == first_receipt.get('userMessageId')
           and replay_terminal.get('messageId') == first_receipt.get('messageId')
           and replay_terminal.get('text') == first_receipt.get('text'),
           elapsedSeconds=round(replay_elapsed, 3), frameTypes=[frame.get('type') for frame in replay_frames])
    record('重复POST未增加原生输入或模型请求', before_replay == after_replay
           and after_replay['userInputCount'] == 1 and after_replay['requestHeaderCount'] == 1,
           before=before_replay, after=after_replay)
    phase('restart-receipt')
    await stop()
    await launch(2)
    restarted_receipt = await generation(first_id, first_generation)
    evidence['restartedReceipt'] = restarted_receipt
    record('宿主重启后按客户端和轮次身份恢复回执', isinstance(restarted_receipt, dict)
           and receipt_identity(restarted_receipt) == receipt_identity(first_receipt),
           **receipt_summary(restarted_receipt))
    phase('cold-replay')
    phase_name[0] = 'duplicate-after-restart'
    cold_generation, cold_frames, cold_elapsed = await submit_observation(first_id, first_prompt, disconnect=False)
    cold_terminal = next((frame for frame in reversed(cold_frames) if frame.get('type') in ('done', 'error')), {})
    cold_stats = await native_ready(first_id, require_request=True)
    record('重启后重复POST仍重放同一结果且不重复模型', cold_generation is not None
           and cold_generation.get('generationId') == first_generation and cold_terminal.get('type') == 'done'
           and cold_terminal.get('text') == first_receipt.get('text') and cold_stats == before_replay,
           elapsedSeconds=round(cold_elapsed, 3), statistics=cold_stats)

    phase('precise-cancel-submit')
    phase_name[0] = 'precise-cancel-running'
    cancel_marker = 'OAI_CANCEL_' + token
    cancel_announced, _, _ = await submit_observation(cancel_id, long_prompt(cancel_marker, 24), disconnect=True)
    record('取消目标具有独立轮次身份', isinstance(cancel_announced, dict)
           and cancel_announced.get('generationId') != first_generation,
           generationId=cancel_announced.get('generationId') if cancel_announced else None)
    cancel_generation = cancel_announced['generationId']
    started_stats = await native_ready(cancel_id, require_request=True)
    before_cancel = await generation(cancel_id, cancel_generation)
    record('精确取消前已有真实模型请求且目标运行中', started_stats['requestHeaderCount'] >= 1
           and isinstance(before_cancel, dict) and before_cancel.get('state') == 'running',
           statistics=started_stats, **receipt_summary(before_cancel))
    phase('precise-cancel-http')
    http_status, cancel_response = await request('POST', session_route + '/cancel', {'value': {'generationId': cancel_generation}})
    evidence['cancelResponses'].append({'purpose': 'running-target', 'httpStatus': http_status, 'body': cancel_response})
    # HTTP 200 + unknown 只证明接口回应，不能标记成客户端已经停止成功。
    record('运行中精确取消HTTP回执明确确认取消', cancel_response.get('outcome') == 'cancelled', fatal=False,
           httpStatus=http_status, response=cancel_response,
           code=None if cancel_response.get('outcome') == 'cancelled' else 'CANCEL_RECEIPT_NOT_CONFIRMED')
    phase('precise-cancel-terminal')
    cancelled_receipt, cancel_states = await await_terminal(cancel_id, cancel_generation)
    evidence['cancelledReceipt'] = cancelled_receipt
    record('精确取消后原生轮次最终确认cancelled', cancelled_receipt.get('state') == 'cancelled', fatal=False,
           states=cancel_states, **receipt_summary(cancelled_receipt))

    phase('stale-cancel-successor-submit')
    phase_name[0] = 'successor-with-stale-cancel'
    successor_marker = 'OAI_SUCCESSOR_' + token
    successor_announced, _, _ = await submit_observation(successor_id, long_prompt(successor_marker, 12), disconnect=True)
    record('新任务具有独立轮次身份', isinstance(successor_announced, dict)
           and successor_announced.get('generationId') not in (first_generation, cancel_generation),
           generationId=successor_announced.get('generationId') if successor_announced else None)
    successor_generation = successor_announced['generationId']
    successor_before = await generation(successor_id, successor_generation)
    record('旧目标取消前新任务正在运行', isinstance(successor_before, dict)
           and successor_before.get('state') == 'running', **receipt_summary(successor_before))
    phase('stale-cancel-http')
    stale_status, stale_response = await request('POST', session_route + '/cancel', {'value': {'generationId': first_generation}})
    evidence['cancelResponses'].append({'purpose': 'old-completed-target', 'httpStatus': stale_status, 'body': stale_response})
    record('取消旧完成目标明确返回already_completed', stale_response.get('outcome') == 'already_completed',
           httpStatus=stale_status, response=stale_response)
    successor_after = await generation(successor_id, successor_generation)
    record('旧目标取消未把新任务标记为cancelled', isinstance(successor_after, dict)
           and successor_after.get('state') in ('queued', 'running', 'completed'), **receipt_summary(successor_after))
    phase('successor-terminal')
    successor_receipt, successor_states = await await_terminal(successor_id, successor_generation)
    evidence['successorReceipt'] = successor_receipt
    record('旧目标取消后的新任务真实完成', successor_receipt.get('state') == 'completed'
           and successor_marker + '_END' in successor_receipt.get('text', ''),
           states=successor_states, **receipt_summary(successor_receipt))
    phase('final-native-evidence')
    statistics = {client_id: input_statistics(synthetic_events(home), client_id)
                  for client_id in (first_id, cancel_id, successor_id)}
    evidence['inputStatistics'] = statistics
    record('三个真实输入各自只有一条原生用户消息', all(item['userInputCount'] == 1 for item in statistics.values()),
           statistics=statistics)
    await stop()
    phase('finished')
