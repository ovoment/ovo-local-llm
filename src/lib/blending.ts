// [START] Model blending API wrappers.
import type { SidecarPorts } from "../types/sidecar";
import { DEFAULT_PORTS } from "./api";

function nativeBase(ports: SidecarPorts): string {
  return `http://127.0.0.1:${ports.native}`;
}

async function jsonOrThrow<T>(resp: Response): Promise<T> {
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${resp.statusText}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export interface BlendRun {
  run_id: string;
  name: string;
  method: string;
  status: "pending" | "running" | "done" | "error" | "cancelled";
  progress: number;
  elapsed_seconds: number;
  error: string | null;
  output_path?: string;
  sources?: { repo_id: string; weight: number }[];
}

export interface BlendedModel {
  name: string;
  method: string;
  sources: { repo_id: string; weight: number }[];
  created_at: string;
  size_bytes: number;
  path: string;
}

export async function startBlend(
  name: string,
  method: string,
  sources: { repo_id: string; weight: number }[],
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<{ run_id: string; name: string; status: string }> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, method, sources }),
  });
  return jsonOrThrow(resp);
}

export async function getBlendProgress(
  runId: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<BlendRun> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/runs/${runId}`);
  return jsonOrThrow<BlendRun>(resp);
}

export async function listBlendRuns(
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<BlendRun[]> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/runs`);
  return jsonOrThrow<BlendRun[]>(resp);
}

export async function cancelBlend(
  runId: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<{ cancelled: boolean }> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/runs/${runId}/cancel`, {
    method: "POST",
  });
  return jsonOrThrow(resp);
}

export async function listBlendedModels(
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<BlendedModel[]> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/models`);
  return jsonOrThrow<BlendedModel[]>(resp);
}

export async function deleteBlendedModel(
  name: string,
  ports: SidecarPorts = DEFAULT_PORTS,
): Promise<{ deleted: boolean }> {
  const resp = await fetch(`${nativeBase(ports)}/ovo/blend/models/${name}`, {
    method: "DELETE",
  });
  return jsonOrThrow(resp);
}
// [END]
