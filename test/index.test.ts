import { describe, it, expect } from "vitest";
import {
  parseInput,
  parseAmountStr,
  formatDateYMD,
  parseDateYMD,
  formatCbteNro,
  formatCurrency,
  formatDateAR,
} from "../src/index";

describe("parseAmountStr", () => {
  it("parses a simple integer", () => {
    expect(parseAmountStr("15000")).toBe(15000);
  });

  it("parses decimal with dot", () => {
    expect(parseAmountStr("15000.50")).toBe(15000.5);
  });

  it("parses decimal with comma (AR style)", () => {
    expect(parseAmountStr("15000,50")).toBe(15000.5);
  });

  it("parses AR thousands format: 1.500,50", () => {
    expect(parseAmountStr("1.500,50")).toBe(1500.5);
  });

  it("parses US thousands format: 1,500.50", () => {
    expect(parseAmountStr("1,500.50")).toBe(1500.5);
  });

  it("parses AR thousands without decimals: 1.500", () => {
    expect(parseAmountStr("1.500")).toBe(1500);
  });

  it("parses multiple AR thousands dots: 1.500.000", () => {
    expect(parseAmountStr("1.500.000")).toBe(1500000);
  });

  it("strips $ sign", () => {
    expect(parseAmountStr("$15000")).toBe(15000);
  });

  it("strips spaces", () => {
    expect(parseAmountStr(" 15000 ")).toBe(15000);
  });

  it("returns null for zero", () => {
    expect(parseAmountStr("0")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseAmountStr("")).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    expect(parseAmountStr("hello")).toBeNull();
  });

  it("returns null for amounts over 10M", () => {
    expect(parseAmountStr("10000001")).toBeNull();
  });

  it("accepts amounts at exactly 10M", () => {
    expect(parseAmountStr("10000000")).toBe(10000000);
  });

  it("treats 100.999 as AR thousands (100999)", () => {
    // 3 digits after dot = thousands separator in AR format
    expect(parseAmountStr("100.999")).toBe(100999);
  });

  it("rounds to 2 decimal places", () => {
    expect(parseAmountStr("100,99")).toBe(100.99);
  });

  it("parses 100.50 as decimal (not thousands)", () => {
    expect(parseAmountStr("100.50")).toBe(100.5);
  });
});

describe("parseInput", () => {
  it("parses a simple integer amount", () => {
    const result = parseInput("15000");
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(15000);
  });

  it("parses AR format amount: 1.500,50", () => {
    const result = parseInput("1.500,50");
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(1500.5);
  });

  it("parses amount with dd/mm date", () => {
    const result = parseInput("15000 28/03");
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(15000);
    expect(result!.date.getDate()).toBe(28);
    expect(result!.date.getMonth()).toBe(2); // March = 2
  });

  it("parses amount with dd/mm/yyyy date", () => {
    const result = parseInput("15000 28/03/2026");
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(15000);
    expect(result!.date.getDate()).toBe(28);
    expect(result!.date.getMonth()).toBe(2);
    expect(result!.date.getFullYear()).toBe(2026);
  });

  it("parses amount with 2-digit year", () => {
    const result = parseInput("15000 28/03/26");
    expect(result).not.toBeNull();
    expect(result!.date.getFullYear()).toBe(2026);
  });

  it("parses single-digit day and month", () => {
    const result = parseInput("5000 1/3");
    expect(result).not.toBeNull();
    expect(result!.date.getDate()).toBe(1);
    expect(result!.date.getMonth()).toBe(2);
  });

  it("parses decimal amount with date", () => {
    const result = parseInput("1500.75 15/06");
    expect(result).not.toBeNull();
    expect(result!.amount).toBe(1500.75);
    expect(result!.date.getDate()).toBe(15);
    expect(result!.date.getMonth()).toBe(5);
  });

  it("returns null for invalid date: Feb 31", () => {
    expect(parseInput("15000 31/02")).toBeNull();
  });

  it("returns null for invalid date: month 13", () => {
    expect(parseInput("15000 15/13")).toBeNull();
  });

  it("returns null for invalid date: day 32", () => {
    expect(parseInput("15000 32/01")).toBeNull();
  });

  it("returns null for zero amount", () => {
    expect(parseInput("0")).toBeNull();
  });

  it("returns null for negative amount", () => {
    expect(parseInput("-500")).toBeNull();
  });

  it("returns null for non-numeric text", () => {
    expect(parseInput("hello")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseInput("")).toBeNull();
  });

  it("returns null for just a date", () => {
    expect(parseInput("28/03")).toBeNull();
  });

  it("returns null for amounts over max", () => {
    expect(parseInput("99999999999")).toBeNull();
  });
});

describe("formatDateYMD", () => {
  it("formats a date as YYYYMMDD", () => {
    expect(formatDateYMD(new Date(2026, 2, 28))).toBe("20260328");
  });

  it("zero-pads single-digit month and day", () => {
    expect(formatDateYMD(new Date(2026, 0, 5))).toBe("20260105");
  });
});

describe("parseDateYMD", () => {
  it("parses YYYYMMDD string to Date", () => {
    const date = parseDateYMD("20260328");
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(28);
  });

  it("roundtrips with formatDateYMD", () => {
    const original = new Date(2026, 5, 15);
    const str = formatDateYMD(original);
    const parsed = parseDateYMD(str);
    expect(parsed.getFullYear()).toBe(original.getFullYear());
    expect(parsed.getMonth()).toBe(original.getMonth());
    expect(parsed.getDate()).toBe(original.getDate());
  });
});

describe("formatCbteNro", () => {
  it("formats punto de venta and comprobante number with padding", () => {
    expect(formatCbteNro(1, 123)).toBe("00001-00000123");
  });

  it("handles larger numbers", () => {
    expect(formatCbteNro(10, 99999999)).toBe("00010-99999999");
  });
});

describe("formatCurrency", () => {
  it("formats a number as ARS currency", () => {
    const result = formatCurrency(15000);
    expect(result).toContain("15.000");
  });

  it("includes decimals", () => {
    const result = formatCurrency(1500.5);
    expect(result).toContain("1.500,50");
  });
});

describe("formatDateAR", () => {
  it("formats date in Argentine locale", () => {
    const result = formatDateAR(new Date(2026, 2, 28));
    expect(result).toContain("28");
    expect(result).toContain("03");
    expect(result).toContain("2026");
  });
});
