import type { CortexM } from "dapjs";

export type FirmwareImage = {
  address: number;
  data: Uint8Array;
  format: "bin" | "elf";
};

export type FlashCallbacks = {
  addLog(text: string): void;
  setProgress(value: number): void;
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

export type CortexTargetConfig = Py32F0TargetConfig;

export type CortexFlashAlgorithm = (
  target: CortexM,
  firmwareImage: FirmwareImage,
  targetConfig: CortexTargetConfig,
  callbacks: FlashCallbacks
) => Promise<void>;
