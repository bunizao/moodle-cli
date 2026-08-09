export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
}

export function problemResponse(
  status: number,
  code: string,
  title: string,
  detail: string,
  headers?: HeadersInit,
): Response {
  return Response.json(
    {
      type: `https://moodle-cli.dev/problems/${code.toLowerCase().replaceAll("_", "-")}`,
      title,
      status,
      detail,
      code,
    } satisfies ProblemDetails,
    {
      status,
      headers: {
        "content-type": "application/problem+json; charset=utf-8",
        ...Object.fromEntries(new Headers(headers)),
      },
    },
  );
}
