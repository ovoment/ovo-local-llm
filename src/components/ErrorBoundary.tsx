import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, info: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, info });
    console.error("[ErrorBoundary]", error, info);
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="h-screen overflow-auto bg-[#FAF3E7] text-[#2C1810] p-8 font-mono text-sm">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-xl font-bold text-rose-700 mb-2">렌더 에러 🚨</h1>
          <p className="text-[#8B4432] mb-4">
            앱이 crash 했어. 아래 스택을 복사해서 알려줘.
          </p>
          <pre className="p-4 bg-white/70 border border-[#E8CFBB] rounded-lg whitespace-pre-wrap break-words mb-3">
            {error.name}: {error.message}
            {"\n\n"}
            {error.stack ?? ""}
          </pre>
          {info?.componentStack && (
            <pre className="p-4 bg-white/70 border border-[#E8CFBB] rounded-lg whitespace-pre-wrap break-words text-[11px] text-[#8B4432]">
              {info.componentStack}
            </pre>
          )}
          <button
            onClick={this.reset}
            className="mt-4 px-4 py-2 rounded-md bg-[#D97757] text-white text-xs hover:bg-[#B85D3F] transition"
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }
}
