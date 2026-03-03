export function reverseRiskBoost(questions, responses) {
  if (!responses) return 0;
  let endorsed = 0;
  for (const qq of questions) {
    if (qq.reverse && Number(responses[qq.id]) >= 3) endorsed++;
  }
  return Math.min(0.20, endorsed * 0.05);
}

export function computeCombinedFromAnalyses({
  themes,
  questions,
  selfAnalysis,
  mgrAnalysis,
  selfResponses,
  mgrResponses
}) {
  const sMap = Object.fromEntries(selfAnalysis.themeScores.map(t => [t.theme, t.score]));
  const mMap = Object.fromEntries(mgrAnalysis.themeScores.map(t => [t.theme, t.score]));

  const riskBoost = Math.max(
    reverseRiskBoost(questions, selfResponses),
    reverseRiskBoost(questions, mgrResponses)
  );

  const wNeed = 0.70;
  const wGap  = 0.30;

  const rows = Object.keys(themes).map(theme => {
    const self = sMap[theme];
    const manager = mMap[theme];
    const delta = manager - self;
    const gap = Math.abs(delta);
    const avg = (self + manager) / 2;
    const need = 4 - avg;
    const priority = (need * wNeed) + (gap * wGap) + riskBoost;
    return { theme, self, manager, delta, gap, avg, need, priority, bucket: themes[theme].bucket, desc: themes[theme].desc };
  });

  const avgAbs = rows.reduce((a, r) => a + r.gap, 0) / rows.length;
  const alignment = Math.max(0, Math.min(100, (1 - (avgAbs / 3)) * 100));

  const topPriorities = [...rows].sort((a,b) => b.priority - a.priority).slice(0, 3);

  return { rows, avgAbs, alignment, topPriorities, weights: { wNeed, wGap }, riskBoost };
}
