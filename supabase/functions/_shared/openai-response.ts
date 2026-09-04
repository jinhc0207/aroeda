/**
 * OpenAI Responses API 응답에서 답변 문장을 꺼내는 helper
 *
 * 이 파일은 실행 환경에 묶이지 않는다. 네트워크도, 환경변수도 읽지 않는다.
 * 여러 기능이 같은 방식으로 응답을 읽도록 한 곳에 둔다.
 *
 * 원본 응답을 로그하거나 저장하지 않는다.
 */

/**
 * 응답 안의 답변 문장(output_text)을 모아서 돌려준다.
 * 문장이 하나도 없으면 null.
 */
export function extractOutputText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;

  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      const { type, text } = part as { type?: unknown; text?: unknown };
      if (type === 'output_text' && typeof text === 'string') parts.push(text);
    }
  }

  return parts.length > 0 ? parts.join('') : null;
}

/** 모델이 답하기를 거절했는지 본다. */
export function hasRefusal(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return false;

  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'refusal') {
        return true;
      }
    }
  }
  return false;
}
