import type { Standing } from "@/lib/remote-players";

// rows on the board; we are always on it, also when ranked below these
const TOP_ROWS = 5;

interface HuntingScoreProps {
  self: Standing;
  others: Standing[];
}

// Our Hunting Score (points for every rock, tree and plant we break) and how everyone online
// compares, highest first.
export default function HuntingScore({ self, others }: HuntingScoreProps) {
  const ranked = [self, ...others].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const rows = ranked
    .map((standing, index) => ({ standing, rank: index + 1 }))
    .filter(({ standing, rank }) => rank <= TOP_ROWS || standing === self);

  return (
    <section
      aria-labelledby="hunting-score-title"
      className="pointer-events-none absolute top-3 left-3 w-[200px] rounded-xl border border-white/15 bg-black/55 p-3 text-white shadow-lg backdrop-blur-sm select-none"
    >
      <h2 id="hunting-score-title" className="text-[11px] font-semibold tracking-wider text-amber-200/80 uppercase">
        Hunting Score
      </h2>
      {/* keyed by the score, so every change replays the pop */}
      <p
        key={self.score}
        className="origin-left font-mono text-3xl font-bold text-amber-300 tabular-nums motion-safe:animate-score-pop"
      >
        {self.score}
      </p>
      <ol aria-label="Scoreboard" className="mt-2 space-y-0.5 border-t border-white/10 pt-2 text-[13px]">
        {rows.map(({ standing, rank }) => (
          <li
            key={standing.id}
            aria-current={standing === self}
            className={`flex items-center gap-2 rounded-md px-1.5 py-0.5 ${
              standing === self ? "bg-white/10 font-semibold" : "text-white/80"
            }`}
          >
            <span className="w-4 text-right font-mono text-[11px] text-white/50">{rank}</span>
            {/* the same colour as their arrow on the radar and their name tag */}
            <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: standing.color }} />
            <span className="min-w-0 flex-1 truncate">{standing.name}</span>
            <span className="font-mono tabular-nums">{standing.score}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
