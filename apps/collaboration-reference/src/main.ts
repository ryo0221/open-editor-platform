import { createReferenceServer } from './server';
const server = createReferenceServer();
const port = Number(process.env.COLLABORATION_PORT ?? 4180);
server.listen(port, '127.0.0.1', () =>
  process.stdout.write(
    `Reference collaboration authority ready on ${port} (in-memory; demo authentication)\n`,
  ),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () => server.close(() => process.exit(0)));
