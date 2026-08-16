export interface NumericOptionBounds {
  readonly min?: number;
  readonly max?: number;
}

function describeBounds(bounds: NumericOptionBounds): string {
  if (bounds.min !== undefined && bounds.max !== undefined) {
    return ` between ${bounds.min} and ${bounds.max}`;
  }
  if (bounds.min !== undefined) return ` greater than or equal to ${bounds.min}`;
  if (bounds.max !== undefined) return ` less than or equal to ${bounds.max}`;
  return "";
}

export function parseFiniteNumber(
  source: string,
  optionName: string,
  bounds: NumericOptionBounds = {},
): number {
  if (source.trim() === "") throw new Error(`${optionName} must be a finite number.`);
  const value = Number(source);
  if (!Number.isFinite(value)) throw new Error(`${optionName} must be a finite number.`);
  if ((bounds.min !== undefined && value < bounds.min)
    || (bounds.max !== undefined && value > bounds.max)) {
    throw new Error(`${optionName} must be${describeBounds(bounds)}.`);
  }
  return value;
}

export function parseInteger(
  source: string,
  optionName: string,
  bounds: NumericOptionBounds = {},
): number {
  const value = parseFiniteNumber(source, optionName);
  if (!Number.isSafeInteger(value)) throw new Error(`${optionName} must be an integer.`);
  if ((bounds.min !== undefined && value < bounds.min)
    || (bounds.max !== undefined && value > bounds.max)) {
    throw new Error(`${optionName} must be an integer${describeBounds(bounds)}.`);
  }
  return value;
}

export function parseFiniteVector3(
  value: Record<string, unknown>,
  optionName: string,
): { x: number; y: number; z: number } {
  const keys = Object.keys(value);
  if (keys.length !== 3 || !keys.includes("x") || !keys.includes("y") || !keys.includes("z")) {
    throw new Error(`${optionName} must be a JSON object containing exactly x, y, and z.`);
  }
  for (const coordinate of ["x", "y", "z"] as const) {
    if (typeof value[coordinate] !== "number" || !Number.isFinite(value[coordinate])) {
      throw new Error(`${optionName}.${coordinate} must be a finite number.`);
    }
  }
  return { x: value.x as number, y: value.y as number, z: value.z as number };
}
