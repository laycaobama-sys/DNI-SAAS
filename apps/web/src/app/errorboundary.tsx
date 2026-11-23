import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

type Props = { children: ReactNode; homeHref?: string; scope?: "module" | "app" };
type State = { error: Error | null };

/**
 * Contiene cualquier fallo de render de un módulo: el resto de la app sigue usable.
 * Nunca muestra la traza ni datos del usuario; solo registra el nombre y el mensaje en la consola.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[dni] fallo de interfaz contenido", error.name, error.message, info.componentStack?.split("\n").slice(0, 4).join(" "));
  }

  reset = () => this.setState({ error: null });

  override render() {
    if (!this.state.error) return this.props.children;
    const home = this.props.homeHref ?? "/app/";
    return (
      <div role="alert" className="mx-auto max-w-xl rounded-3xl border border-line bg-surface p-8 text-center">
        <AlertTriangle className="mx-auto size-10 text-warn" aria-hidden />
        <h1 className="mt-4 font-serif text-3xl leading-tight">Esta sección no se ha podido mostrar</h1>
        <p className="mt-3 text-sm text-mute">
          Tus datos están a salvo: no se ha perdido ni enviado nada. Puedes reintentar o volver al inicio; si se repite, recarga la página.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={this.reset}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90"
          >
            <RotateCcw className="size-4" aria-hidden /> Reintentar
          </button>
          <a href={home} className="inline-flex min-h-11 items-center rounded-full border border-line px-5 text-sm font-semibold hover:bg-surface-2">
            Volver al Command Center
          </a>
        </div>
      </div>
    );
  }
}
