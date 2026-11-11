"""只使用合成目录与 Mock，验证明确 Profile 参数没有约束重启目标。"""
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import json
import tempfile
from oai_core import configuration

base = Path(__file__).parent / "restart-profile-fixture"
(base / "target-home").mkdir(parents=True, exist_ok=True)
(base / "other-home").mkdir(parents=True, exist_ok=True)
calls = []
def fake_run(command, **kwargs):
    calls.append(command)
    return SimpleNamespace(returncode=0, stdout="active\n")
with patch("sys.platform", "linux"), patch.object(configuration, "detect_host_agents", return_value={"dsh":[base / "other-home"]}), patch("subprocess.run", side_effect=fake_run):
    actual = configuration.restart_dsh_service_if_active(base / "target-home", "worker")
assert actual is True
restarted = [c for c in calls if "restart" in c]
assert restarted and restarted[0][-1] == "dsh.service"
assert all("worker" not in part and str(base / "target-home") not in part for c in calls for part in c)
print(json.dumps({"用例":"明确指定 target-home / worker", "结果":actual,"实际重启":restarted,"包含所选Profile":False}, ensure_ascii=False))
print("1 个缺陷复现断言通过；未执行真实 systemctl 或进程信号")
