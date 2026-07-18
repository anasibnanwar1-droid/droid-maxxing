/** Placeholder rows while a switched thread's history loads — no blank flash. */
export default function ThreadSkeleton() {
  return (
    <div className="flex animate-pulse flex-col gap-3 px-4 py-4">
      <div className="h-8 w-3/5 self-end rounded-2xl rounded-br-md bg-white/[0.06]" />
      <div className="h-3 w-11/12 rounded bg-white/[0.05]" />
      <div className="h-3 w-4/5 rounded bg-white/[0.05]" />
      <div className="h-3 w-2/3 rounded bg-white/[0.04]" />
      <div className="mt-2 h-7 w-5/6 rounded-lg bg-white/[0.04]" />
      <div className="h-3 w-3/4 rounded bg-white/[0.04]" />
      <div className="h-8 w-1/2 self-end rounded-2xl rounded-br-md bg-white/[0.05]" />
      <div className="h-3 w-5/6 rounded bg-white/[0.04]" />
      <div className="h-3 w-2/3 rounded bg-white/[0.03]" />
    </div>
  );
}
