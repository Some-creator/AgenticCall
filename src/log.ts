// All logs go to stderr: in stdio mode stdout carries the MCP protocol.
const ts = () => new Date().toISOString();
export const log = {
  info: (msg: string) => console.error(`${ts()} INFO  ${msg}`),
  warn: (msg: string) => console.error(`${ts()} WARN  ${msg}`),
  error: (msg: string) => console.error(`${ts()} ERROR ${msg}`),
};
