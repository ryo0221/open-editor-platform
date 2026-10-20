const totals = { jobs: 0, handedBytes: 0, acknowledgedBytes: 0, unprovenBytes: 0 };
export const codecInputDiagnostics = () => ({
  ...totals,
  terminationAcknowledged: false,
  codecReclamationProven: false,
});
/** Scalar inventory of accepted AAC-owned transferred inputs, separate from managed PCM. */
export function observeCodecInputs(state) {
  totals.jobs++;
  const evidence = {
    handedBytes: 0,
    acknowledgedBytes: 0,
    unprovenBytes: 0,
    peakBytes: 0,
    terminationAcknowledged: false,
    codecReclamationProven: false,
  };
  const add = state.encoders.add.bind(state.encoders);
  state.encoders.add = (encoder) => {
    add(encoder);
    const send = encoder.sendCommand;
    encoder.sendCommand = function (command, transfers) {
      const buffer = command.type === 'encode' ? command.data.audioData : undefined;
      const bytes = buffer?.byteLength ?? 0;
      const work = send.call(this, command, transfers);
      if (bytes && buffer.byteLength === 0) {
        totals.handedBytes += bytes;
        totals.unprovenBytes += bytes;
        evidence.handedBytes += bytes;
        evidence.unprovenBytes += bytes;
        evidence.peakBytes = Math.max(evidence.peakBytes, evidence.unprovenBytes);
        void work.then(
          () => {
            totals.unprovenBytes -= bytes;
            totals.acknowledgedBytes += bytes;
            evidence.unprovenBytes -= bytes;
            evidence.acknowledgedBytes += bytes;
          },
          () => {},
        ); // Rejected RPC / terminated worker never certifies input drain.
      }
      return work;
    };
    return state.encoders;
  };
  return evidence;
}
