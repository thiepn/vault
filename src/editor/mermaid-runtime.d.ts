export interface MermaidRenderResult { svg: string }
export interface MermaidRuntime {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: 'strict';
    theme: 'neutral';
    suppressErrorRendering: boolean;
  }): void;
  render(id: string, source: string): Promise<MermaidRenderResult>;
}
declare const mermaid: MermaidRuntime;
export default mermaid;
