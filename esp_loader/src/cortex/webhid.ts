import type { Transport as DapTransport } from "dapjs";

export type WebHidDevice = EventTarget & {
  opened: boolean;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  vendorId?: number;
  productId?: number;
  open(): Promise<void>;
  close(): Promise<void>;
  sendReport(reportId: number, data: BufferSource): Promise<void>;
};

export type WebHidApi = {
  getDevices?: () => Promise<WebHidDevice[]>;
  requestDevice(options: { filters: unknown[] }): Promise<WebHidDevice[]>;
  addEventListener?: (type: string, listener: EventListener) => void;
  removeEventListener?: (type: string, listener: EventListener) => void;
};

type PendingRead = {
  resolve: (data: DataView) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class WebHidCmsisDapTransport implements DapTransport {
  public readonly packetSize = 64;

  private readonly device: WebHidDevice;
  private readonly reports: DataView[] = [];
  private pendingRead: PendingRead | null = null;
  private listening = false;

  constructor(device: WebHidDevice) {
    this.device = device;
  }

  private readonly onInputReport = (event: Event) => {
    const data = (event as Event & { data: DataView }).data;
    const report = new DataView(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
    );
    if (this.pendingRead) {
      const pending = this.pendingRead;
      this.pendingRead = null;
      clearTimeout(pending.timeout);
      pending.resolve(report);
    } else {
      this.reports.push(report);
    }
  };

  async open(): Promise<void> {
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
    try {
      if (!this.device.opened) await this.device.open();
    } catch (error) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    this.reports.length = 0;
    if (this.pendingRead) {
      const pending = this.pendingRead;
      this.pendingRead = null;
      clearTimeout(pending.timeout);
      pending.reject(new Error("CMSIS-DAP v1 cerrado mientras esperaba una respuesta"));
    }
    if (this.device.opened) await this.device.close();
  }

  async read(): Promise<DataView> {
    const report = this.reports.shift();
    if (report) return report;
    if (this.pendingRead) throw new Error("Ya hay una lectura CMSIS-DAP v1 pendiente");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRead = null;
        reject(new Error("CMSIS-DAP v1 no respondió por WebHID en 5 segundos"));
      }, 5000);
      this.pendingRead = { resolve, reject, timeout };
    });
  }

  async write(data: BufferSource): Promise<void> {
    const source = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const packet = new Uint8Array(this.packetSize);
    packet.set(source.slice(0, this.packetSize));
    await this.device.sendReport(0, packet);
  }
}
