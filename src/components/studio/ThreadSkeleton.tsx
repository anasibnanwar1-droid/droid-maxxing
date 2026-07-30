/** Placeholder rows while a switched thread's history loads — no blank flash. */
export default function ThreadSkeleton() {
  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <div className="skeleton-block h-8 w-3/5 self-end rounded-2xl rounded-br-md" />
      <div className="skeleton-block h-3 w-11/12" />
      <div className="skeleton-block h-3 w-4/5" />
      <div className="skeleton-block h-3 w-2/3" />
      <div className="skeleton-block mt-2 h-7 w-5/6 rounded-lg" />
      <div className="skeleton-block h-3 w-3/4" />
      <div className="skeleton-block h-8 w-1/2 self-end rounded-2xl rounded-br-md" />
      <div className="skeleton-block h-3 w-5/6" />
      <div className="skeleton-block h-3 w-2/3" />
    </div>
  );
}
