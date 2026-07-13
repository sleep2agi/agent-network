export const GROK_WIRE_BASELINE = Object.freeze({
  product: "grok",
  semver: "0.2.93",
  build: "f00f96316d",
  binarySha256: "4e0738d3b5550f3c842bc0ae69f468815c6329c008a110d0c27a694dc3401135",
});

export function isExactGrokWireBaseline(value) {
  return Boolean(value)
    && value.product === GROK_WIRE_BASELINE.product
    && value.semver === GROK_WIRE_BASELINE.semver
    && value.build === GROK_WIRE_BASELINE.build
    && value.binarySha256 === GROK_WIRE_BASELINE.binarySha256
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify(Object.keys(GROK_WIRE_BASELINE).sort());
}
