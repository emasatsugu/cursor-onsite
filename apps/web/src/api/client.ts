import type {
  ApiError,
  CreateThreadRequest,
  CreateThreadResponse,
  PostMessageRequest,
  PostMessageResponse,
  ThreadDetail,
  ThreadsListResponse,
} from "@poc/shared";

const HTTP_BASE =
  import.meta.env.VITE_CP_HTTP_URL?.replace(/\/$/, "") || "http://localhost:3001";

export class ApiClientError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${HTTP_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = res.statusText || `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as ApiError;
      if (body?.error) message = body.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new ApiClientError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}

export function listThreads(): Promise<ThreadsListResponse> {
  return request<ThreadsListResponse>("/threads");
}

export function getThread(id: string): Promise<ThreadDetail> {
  return request<ThreadDetail>(`/threads/${id}`);
}

export function createThread(
  body: CreateThreadRequest,
): Promise<CreateThreadResponse> {
  return request<CreateThreadResponse>("/threads", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function postMessage(
  threadId: string,
  body: PostMessageRequest,
): Promise<PostMessageResponse> {
  return request<PostMessageResponse>(`/threads/${threadId}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
