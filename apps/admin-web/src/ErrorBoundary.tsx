import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Check, Copy, RefreshCw, X } from 'lucide-react';
import { formatErrorReport, isIgnorableErrorMessage } from './errorReport';

// Перехват и показ ошибок интерфейса в «красивой рамке» (issue #230). Покрывает
// три источника:
//  - ошибки рендера React (componentDidCatch / getDerivedStateFromError) —
//    например, «Minified React error #185»; в этом случае поддерево заменяется
//    рамкой, чтобы приложение не «падало» в белый экран;
//  - необработанные ошибки окна (window 'error') — то самое «Uncaught Error …»;
//  - необработанные отклонения промисов (unhandledrejection).
// В двух последних случаях рамка показывается оверлеем поверх живого интерфейса.
// Текст ошибки оформлен как Markdown и готов к копированию в задачу на доработку.

interface CapturedError {
  message: string;
  stack: string;
  componentStack: string;
  source: string;
  // fatal — ошибка рендера: поддерево нельзя показывать, рисуем рамку вместо него.
  // Не-fatal (окно/промис) — рамка-оверлей поверх работающего интерфейса.
  fatal: boolean;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  // Где находится граница (например, «Редактор схем»), попадает в отчёт.
  scope?: string;
  // Слушать глобальные ошибки окна. Включаем только для корневой границы,
  // чтобы локальные не дублировали один и тот же оверлей.
  listenGlobal?: boolean;
}

interface ErrorBoundaryState {
  captured: CapturedError | null;
  copied: boolean;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Падаем в запасной вариант ниже.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { captured: null, copied: false };

  static getDerivedStateFromError(error: unknown): Partial<ErrorBoundaryState> {
    const err = error instanceof Error ? error : null;
    return {
      captured: {
        message: err?.message || String(error) || 'Неизвестная ошибка',
        stack: err?.stack ?? '',
        componentStack: '',
        source: 'Рендер React',
        fatal: true,
      },
      copied: false,
    };
  }

  componentDidCatch(_error: unknown, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? '';
    this.setState((prev) =>
      prev.captured ? { ...prev, captured: { ...prev.captured, componentStack } } : prev,
    );
  }

  componentDidMount(): void {
    if (!this.props.listenGlobal) return;
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  componentWillUnmount(): void {
    if (!this.props.listenGlobal) return;
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleRejection);
  }

  private handleWindowError = (event: ErrorEvent): void => {
    const err = event.error instanceof Error ? event.error : null;
    const message = err?.message || event.message || 'Необработанная ошибка';
    if (isIgnorableErrorMessage(message)) return;
    this.capture({
      message,
      stack: err?.stack ?? '',
      componentStack: '',
      source: 'Необработанная ошибка окна',
      fatal: false,
    });
  };

  private handleRejection = (event: PromiseRejectionEvent): void => {
    const reason: unknown = event.reason;
    const err = reason instanceof Error ? reason : null;
    const message = err?.message || (typeof reason === 'string' ? reason : 'Необработанное отклонение промиса');
    if (isIgnorableErrorMessage(message)) return;
    this.capture({
      message,
      stack: err?.stack ?? '',
      componentStack: '',
      source: 'Необработанное отклонение промиса',
      fatal: false,
    });
  };

  private capture(captured: CapturedError): void {
    // Не перетираем фатальную ошибку рендера всплывшими событиями окна.
    this.setState((prev) => (prev.captured?.fatal ? prev : { captured, copied: false }));
  }

  private dismiss = (): void => this.setState({ captured: null, copied: false });

  private buildReport(captured: CapturedError): string {
    return formatErrorReport({
      message: captured.message,
      stack: captured.stack,
      componentStack: captured.componentStack,
      scope: this.props.scope,
      source: captured.source,
      href: typeof window !== 'undefined' ? window.location.href : '',
      time: new Date().toISOString(),
    });
  }

  private handleCopy = async (captured: CapturedError): Promise<void> => {
    const ok = await copyToClipboard(this.buildReport(captured));
    if (ok) this.setState({ copied: true });
  };

  render(): ReactNode {
    const { captured, copied } = this.state;
    if (!captured) return this.props.children;

    const report = this.buildReport(captured);
    const frame = (
      <div className="error-frame" role="alert">
        <div className="error-frame-head">
          <span className="error-frame-title">Ошибка интерфейса</span>
          <button
            className="icon-button"
            type="button"
            onClick={this.dismiss}
            title={captured.fatal ? 'Скрыть рамку' : 'Закрыть'}
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>
        <p className="error-frame-message">{captured.message}</p>
        <p className="error-frame-hint">
          Скопируйте отчёт ниже и вставьте его в задачу на доработку.
        </p>
        <textarea className="error-frame-report" value={report} readOnly rows={12} spellCheck={false} />
        <div className="button-row">
          <button className="button" type="button" onClick={() => void this.handleCopy(captured)}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            <span>{copied ? 'Скопировано' : 'Скопировать отчёт'}</span>
          </button>
          {captured.fatal ? (
            <button className="button" type="button" onClick={() => window.location.reload()}>
              <RefreshCw size={16} />
              <span>Перезагрузить</span>
            </button>
          ) : (
            <button className="button" type="button" onClick={this.dismiss}>
              <span>Продолжить работу</span>
            </button>
          )}
        </div>
      </div>
    );

    if (captured.fatal) {
      return <div className="error-frame-page">{frame}</div>;
    }
    return (
      <>
        {this.props.children}
        <div className="error-frame-overlay" role="presentation">
          {frame}
        </div>
      </>
    );
  }
}
