export function LoadingSpinner({ size = 20 }: { size?: number }) {
  return (
    <div
      className="inline-block animate-spin rounded-full border-2 border-solid border-current border-r-transparent align-[-0.125em] motion-reduce:animate-[spin_1.5s_linear_infinite]"
      style={{ width: size, height: size }}
      role="status"
    >
      <span className="sr-only">加载中...</span>
    </div>
  );
}

export function LoadingDots() {
  return (
    <div className="inline-flex items-center gap-1">
      <div className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
      <div className="h-2 w-2 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
      <div className="h-2 w-2 animate-bounce rounded-full bg-current" />
    </div>
  );
}

export function LoadingOverlay({ message }: { message?: string }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg bg-white/90 backdrop-blur-sm">
      <div className="text-center">
        <LoadingSpinner size={32} />
        {message && <p className="mt-3 text-sm font-bold text-ink/70">{message}</p>}
      </div>
    </div>
  );
}
