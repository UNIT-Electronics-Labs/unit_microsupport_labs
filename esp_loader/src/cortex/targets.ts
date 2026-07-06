import type { CortexTargetConfig } from "./types";

export const TARGETS = {
  py32f003x4: {
    label: "PY32F003x4",
    description: "Cortex-M0+, 16 KB flash",
    family: "py32",
    algorithm: "py32f0",
    flashBase: 0x08000000,
    flashSizeBytes: 16 * 1024,
    pageSize: 4096,
    programPageSize: 128,
    timingProfile: "py32f0",
  },
  py32f003x6: {
    label: "PY32F003x6",
    description: "Cortex-M0+, 32 KB flash",
    family: "py32",
    algorithm: "py32f0",
    flashBase: 0x08000000,
    flashSizeBytes: 32 * 1024,
    pageSize: 4096,
    programPageSize: 128,
    timingProfile: "py32f0",
  },
  py32f003x8: {
    label: "PY32F003x8",
    description: "Cortex-M0+, 64 KB flash",
    family: "py32",
    algorithm: "py32f0",
    flashBase: 0x08000000,
    flashSizeBytes: 64 * 1024,
    pageSize: 4096,
    programPageSize: 128,
    timingProfile: "py32f0",
  },
} as const satisfies Record<string, CortexTargetConfig>;

export type TargetKey = keyof typeof TARGETS;
export type TargetConfig = (typeof TARGETS)[TargetKey];
