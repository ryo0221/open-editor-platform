import { schematicSimAnswer, type SchematicSimRequest } from './simulate';

// SL5b: the circuit calculation off the main thread; a cancel terminates this worker.
onmessage = ({ data }: MessageEvent<SchematicSimRequest>) => {
  postMessage(schematicSimAnswer(data));
};
