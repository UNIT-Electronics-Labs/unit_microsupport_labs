export type RainMakerProvisioningData = {
  ver: string;
  name: string;
  transport: "ble" | "softap";
  pop?: string;
  security?: number;
  username?: string;
  password?: string;
};

export type RainMakerProvisioningPayload = {
  payload: string;
  data: RainMakerProvisioningData;
};

function parseProvisioningJson(
  candidate: string
): RainMakerProvisioningPayload | null {
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const transport =
      typeof record.transport === "string"
        ? record.transport.toLowerCase()
        : "";

    if (
      record.ver !== "v1" ||
      typeof record.name !== "string" ||
      record.name.length === 0 ||
      (transport !== "ble" && transport !== "softap") ||
      (record.pop !== undefined && typeof record.pop !== "string") ||
      (record.username !== undefined && typeof record.username !== "string") ||
      (record.password !== undefined && typeof record.password !== "string") ||
      (record.security !== undefined &&
        (!Number.isInteger(record.security) ||
          ![0, 1, 2].includes(record.security as number)))
    ) {
      return null;
    }

    const normalizedRecord = {
      ...record,
      ver: "v1",
      name: record.name,
      transport,
    };

    return {
      payload: JSON.stringify(normalizedRecord),
      data: normalizedRecord as RainMakerProvisioningData,
    };
  } catch {
    return null;
  }
}

export function extractRainMakerProvisioning(
  serialText: string
): RainMakerProvisioningPayload | null {
  const candidates: Array<{
    index: number;
    value: RainMakerProvisioningPayload;
  }> = [];
  const jsonPattern = /\{[^{}\r\n]{1,1200}\}/g;

  for (const match of serialText.matchAll(jsonPattern)) {
    const parsed = parseProvisioningJson(match[0]);
    if (parsed) candidates.push({ index: match.index, value: parsed });
  }

  const encodedDataPattern = /[?&]data=([^\s\r\n]+)/g;
  for (const match of serialText.matchAll(encodedDataPattern)) {
    try {
      const decoded = decodeURIComponent(match[1].replaceAll("+", "%20"));
      const jsonMatch = decoded.match(jsonPattern)?.[0];
      if (!jsonMatch) continue;
      const parsed = parseProvisioningJson(jsonMatch);
      if (parsed) candidates.push({ index: match.index, value: parsed });
    } catch {
      // Ignore incomplete URL-encoded chunks while serial data is arriving.
    }
  }

  candidates.sort((first, second) => first.index - second.index);
  return candidates.at(-1)?.value ?? null;
}
