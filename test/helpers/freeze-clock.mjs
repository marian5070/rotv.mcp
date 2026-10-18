// Fixture tests must not depend on the wall clock: the EPG fixtures describe one day
// (1 Oct 2026), and "upcoming 48 hours" or "today" would drift away from it otherwise.
// Call before importing any tool module.
export function freezeClock(iso) {
  const frozen = new Date(iso).getTime();
  const RealDate = Date;
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [frozen])); }
    static now() { return frozen; }
  };
  return () => { globalThis.Date = RealDate; };
}
