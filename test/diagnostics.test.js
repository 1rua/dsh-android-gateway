import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnosticTrace } from "../src/diagnostics.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("optional native boundary diagnostics", () => {
  it("defaults off and never makes logging the owner of an operation", () => {
    vi.stubEnv("OAI_DSH_ADAPTER_DIAGNOSTICS", "0");
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    diagnosticTrace({})("adapter.dsh.host_submitted");
    expect(write).not.toHaveBeenCalled();
    vi.stubEnv("OAI_DSH_ADAPTER_DIAGNOSTICS", "1");
    write.mockImplementation(() => { throw new Error("diagnostic sink closed"); });
    expect(() => diagnosticTrace({})("adapter.dsh.host_submitted")).not.toThrow();
  });

  it("propagates only validated trace identity and selected public metadata", () => {
    vi.stubEnv("OAI_DSH_ADAPTER_DIAGNOSTICS", "1");
    const lines = [];
    vi.spyOn(process.stderr, "write").mockImplementation((line) => { lines.push(line); return true; });
    const trace = diagnosticTrace({ traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      "x-oai-request-id": "original-request", authorization: "PRIVATE-CREDENTIAL" });
    trace("adapter.dsh.host_submitted", { clientMessageId: "real-client", text: "PRIVATE-BODY" });
    trace("adapter.dsh.native_user_event", { userMessageId: "native-user", state: "PRIVATE-STATE" });
    trace("adapter.dsh.first_content_event", { messageId: "Bearer PRIVATE-ID", token: "PRIVATE-TOKEN" });
    trace("PRIVATE-STAGE");
    const records = lines.map((line) => JSON.parse(line.slice("oai_native ".length)));
    expect(records).toHaveLength(3);
    expect(new Set(records.map((r) => r.bootId)).size).toBe(1);
    expect(records.every((r) => r.traceId === "a".repeat(32) && r.requestId === "original-request")).toBe(true);
    expect(records[0].clientMessageId).toBe("real-client");
    expect(records[1].userMessageId).toBe("native-user");
    expect(BigInt(records[2].monotonicNs) >= BigInt(records[0].monotonicNs)).toBe(true);
    expect(records[2].elapsedMs >= records[0].elapsedMs).toBe(true);
    expect(lines.join("")).not.toContain("PRIVATE");
  });

  it("rejects malformed or zero parent IDs and credential-shaped request headers", () => {
    vi.stubEnv("OAI_DSH_ADAPTER_DIAGNOSTICS", "1");
    const records = [];
    vi.spyOn(process.stderr, "write").mockImplementation((line) => { records.push(JSON.parse(line.slice(11))); return true; });
    for (const traceparent of ["bad-parent", `00-${"0".repeat(32)}-${"a".repeat(16)}-00`]) {
      diagnosticTrace({ traceparent, "x-oai-request-id": "Bearer PRIVATE-HEADER" })("adapter.dsh.message_received");
    }
    expect(records.every((r) => /^[0-9a-f]{32}$/.test(r.traceId) && !/^0+$/.test(r.traceId) && !r.requestId)).toBe(true);
  });
});
