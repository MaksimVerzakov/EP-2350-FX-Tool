/**
 * Where each row of a preset's effect list runs.
 *
 *   1      bus 1 (rows without BUS count as bus 1 unless they come after the bus rows)
 *   2      bus 2, in parallel with bus 1; both get the input and are summed
 *   'mix'  a row without BUS placed after the last row with an explicit BUS: it processes the
 *          sum of both buses (e.g. a final BALANCE that sets the dry/wet mix in a dual mono preset)
 *
 * A preset without any explicit BUS is a plain series chain: every row is lane 1.
 */
export type BusLane = 1 | 2 | 'mix';

export function busLanes(list: ReadonlyArray<{ BUS?: unknown }>): BusLane[] {
  let lastExplicit = -1;
  list.forEach((fx, i) => {
    if (fx && (fx.BUS === 1 || fx.BUS === 2)) lastExplicit = i;
  });
  return list.map((fx, i) => {
    if (fx?.BUS === 2) return 2;
    if (fx?.BUS === 1) return 1;
    return lastExplicit >= 0 && i > lastExplicit ? 'mix' : 1;
  });
}
