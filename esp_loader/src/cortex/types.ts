import type { CortexM } from "dapjs";

export type FirmwareImage = {
  address: number;
  data: Uint8Array;
  format: "bin" | "elf" | "uf2";
};

export type FlashCallbacks = {
  addLog(text: string): void;
  setProgress(value: number): void;
};

export type Stm32F1TargetConfig = {
  label: string;
  description: string;
  family: "stm32" | "gd32";
  algorithm: "stm32f1";
  flashBase: number;
  flashSizeBytes: number;
  pageSize: number;
  deviceId?: number;
};

export type Py32F0TargetConfig = {
  label: string;
  description: string;
  family: "py32";
  algorithm: "py32f0";
  flashBase: number;
  flashSizeBytes: number;
  pageSize: number;
  programPageSize: number;
  timingProfile: "py32f0" | "py32f071";
};

/** RP2350 executes from external QSPI flash mapped at 0x10000000. */
export type Rp2TargetConfig = {
  label: string;
  description: string;
  family: "rp2";
  algorithm: "rp2-rom";
  flashBase: number;
  flashSizeBytes: number;
  pageSize: number;
  sectorSize: number;
  chip: "rp2350";
};

export type CortexTargetConfig =
  | Stm32F1TargetConfig
  | Py32F0TargetConfig
  | Rp2TargetConfig;

export type CortexFlashAlgorithm = (
  target: CortexM,
  firmwareImage: FirmwareImage,
  targetConfig: CortexTargetConfig,
  callbacks: FlashCallbacks
) => Promise<void>;
