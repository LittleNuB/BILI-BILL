export interface ChatImageReference { pageId: string; id: string; videoKey: string }
export const VISION_SETTINGS_KEY = 'learningVisionModel';
export interface VisionSettings { enabled: boolean; model: string }
export function visionSettings(value: unknown): VisionSettings {
  const row = value as Partial<VisionSettings> | null;
  return { enabled: row?.enabled === true, model: typeof row?.model === 'string' ? row.model.trim().slice(0, 200) : '' };
}
