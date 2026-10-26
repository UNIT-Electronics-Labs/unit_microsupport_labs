import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";

const source = await readFile(new URL("../src/cortex/webhid.ts", import.meta.url), "utf8");
const compiled = transpileModule(source, {
  compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2023 },
}).outputText;
const { WebHidCmsisDapTransport } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

class MockHidDevice extends EventTarget {
  opened = false;
  respondImmediately = true;

  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async sendReport(_reportId, data) {
    if (!this.respondImmediately) return;
    const event = new Event("inputreport");
    Object.defineProperty(event, "data", { value: new DataView(Uint8Array.from(data).buffer) });
    this.dispatchEvent(event);
  }
}

test("WebHID conserva respuestas recibidas antes de read()", async () => {
  const device = new MockHidDevice();
  const transport = new WebHidCmsisDapTransport(device);
  await transport.open();
  await transport.write(Uint8Array.of(0x11));
  const response = await transport.read();
  assert.equal(response.getUint8(0), 0x11);
  await transport.close();
});

test("WebHID cancela una lectura pendiente al cerrar", async () => {
  const device = new MockHidDevice();
  device.respondImmediately = false;
  const transport = new WebHidCmsisDapTransport(device);
  await transport.open();
  const response = transport.read();
  const rejected = assert.rejects(response, /cerrado mientras esperaba/);
  await transport.close();
  await rejected;
});
