const json = async (res: Response) => {
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data;
};

export const api = {
  get: <T>(path: string) => fetch(path).then(json) as Promise<T>,
  post: <T>(path: string, body?: unknown) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }).then(json) as Promise<T>,
  del: <T>(path: string) => fetch(path, { method: "DELETE" }).then(json) as Promise<T>,
};

export type AuthState = {
  required: boolean;
  ok: boolean;
  user: { id: string; username: string } | null;
  canRegister: boolean;
};
