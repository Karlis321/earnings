export function LanguageBadge({ lang }: { lang: string }) {
  if (!lang || lang === "en") return null;
  return (
    <span
      className="inline-flex h-[22px] items-center rounded-[5px] border border-bd2 bg-s3 px-[9px] font-mono text-[10.5px] text-tx2"
      aria-label={`Language: ${lang.toUpperCase()}`}
    >
      {lang.toUpperCase()}
    </span>
  );
}
