class TextExtractionMatrix {
  a = 1;
  b = 0;
  c = 0;
  d = 1;
  e = 0;
  f = 0;

  constructor(values?: number[]) {
    if (values && values.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = values as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
    }
  }

  multiplySelf(): this {
    return this;
  }

  preMultiplySelf(): this {
    return this;
  }

  translate(): this {
    return this;
  }

  scale(): this {
    return this;
  }

  invertSelf(): this {
    return this;
  }
}

class TextExtractionPath {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  rect(): void {}
  closePath(): void {}
}

export function installPdfTextExtractionPolyfills(): void {
  if (!("DOMMatrix" in globalThis)) {
    Object.defineProperty(globalThis, "DOMMatrix", {
      value: TextExtractionMatrix,
      configurable: true,
    });
  }
  if (!("Path2D" in globalThis)) {
    Object.defineProperty(globalThis, "Path2D", {
      value: TextExtractionPath,
      configurable: true,
    });
  }
}
