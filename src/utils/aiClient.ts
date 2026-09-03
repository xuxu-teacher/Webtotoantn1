import type { GeneratedLessonPlan, LessonPlanRequest } from '../types';

export async function generateLessonPlan(req: LessonPlanRequest): Promise<GeneratedLessonPlan> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`Sinh KHBD thất bại (${res.status}): ${errBody || res.statusText}`);
  }

  return (await res.json()) as GeneratedLessonPlan;
}
