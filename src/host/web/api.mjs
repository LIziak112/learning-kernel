export async function api(path, input) {
  const request = input && {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ protocolVersion: 1, ...input }),
  };
  const response = await fetch(path, { cache: "no-store", ...request });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error("请求未完成", { cause: response.status }), { code: payload.code });
  return payload;
}
