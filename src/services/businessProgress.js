export function resolveBusinessProgress({ analysisRun = null, personaRun = null } = {}) {
    const runs = [analysisRun, personaRun]
        .filter(Boolean)
        .map((run) => {
            const total = Number(run.progress_total || 0);
            const done = Number(run.progress_done || 0);
            const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;

            return {
                runType: run.run_type || run.type || null,
                status: run.status || 'idle',
                phase: run.phase || 'working',
                label: run.run_type === 'persona_pack' ? 'Persona pack' : 'Analysis',
                active: run.status === 'running',
                percent,
            };
        });

    const activeRun = runs.find((run) => run.active) || null;
    if (!activeRun) {
        return { active: false, label: '', phase: '', percent: 0, status: 'idle' };
    }

    return {
        active: true,
        label: activeRun.label,
        phase: activeRun.phase,
        percent: activeRun.percent,
        status: activeRun.status,
    };
}
