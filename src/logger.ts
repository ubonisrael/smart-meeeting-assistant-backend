export function logFlow(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    service: "backend",
    event,
    timestamp: new Date().toISOString(),
    ...details
  }));
}

export function logFlowError(event: string, details: Record<string, unknown> = {}): void {
  console.error(JSON.stringify({
    service: "backend",
    event,
    timestamp: new Date().toISOString(),
    ...details
  }));
}
