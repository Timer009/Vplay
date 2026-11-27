/**
 * Pick a defect for the repair step. Host/adapter policy can override.
 * This is generic: no Spacer-specific types or selectors.
 */
export function selectDefect(report, { minConfidence = 0.5, preferredTypes = ['ui_occlusion', 'layout', 'rendering'] } = {}) {
  const defects = Array.isArray(report?.defects) ? report.defects : [];
  const eligible = defects
    .filter((defect) => Number(defect.confidence) >= minConfidence)
    .sort((a, b) => {
      const rank = (defect) => {
        const index = preferredTypes.indexOf(defect.defect_type);
        return index === -1 ? preferredTypes.length : index;
      };
      const diff = rank(a) - rank(b);
      if (diff !== 0) return diff;
      return Number(b.confidence) - Number(a.confidence);
    });
  return eligible[0] || null;
}
