import ExcelJS from "exceljs";
import { deflateSync } from "node:zlib";

/** A tiny valid PNG of one solid colour (synthetic stand-in for a logo or a signature). */
export function solidPng(r: number, g: number, b: number, w = 8, h = 4): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.concat(Array.from({ length: h }, () => Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A SYNTHETIC copy of the PFT guide workbook's structure: logo + multi-line header + form text on
 * "Patient Data"; signature images with names written underneath on "RT signature" and "Pulmo Signature".
 * No real names, signatures or logos.
 */
export async function buildSyntheticGuide(): Promise<{ bytes: Buffer; logo: Buffer; rtSig: Buffer; pulmoSig: Buffer }> {
  const logo = solidPng(20, 90, 60);
  const rtSig = solidPng(10, 10, 120);
  const pulmoSig = solidPng(120, 10, 10);
  const wb = new ExcelJS.Workbook();
  const pd = wb.addWorksheet("Patient Data");
  pd.getCell("A2").value = "SYNTHETIC DEMO HOSPTAL, INC\n1 DEMO AVE., DEMO CITY\nTRUNKLINE: (000) 0000-0000";
  pd.getCell("A5").value = "PULMONARY FUNCTION TEST";
  pd.getCell("A7").value = "DATE:";
  pd.getCell("A22").value = "6. Salbutamol was used as the bronchodilator and administered via metered-dose inhaler (MDI).";
  pd.getCell("C52").value = "AS-PUL-PFT-006";
  pd.addImage(wb.addImage({ buffer: logo as unknown as ExcelJS.Buffer, extension: "png" }), { tl: { col: 0, row: 0 }, ext: { width: 60, height: 60 } });
  const rt = wb.addWorksheet("RT signature");
  rt.addImage(wb.addImage({ buffer: logo as unknown as ExcelJS.Buffer, extension: "png" }), { tl: { col: 0, row: 0 }, ext: { width: 40, height: 40 } }); // logo copy: ignored
  rt.addImage(wb.addImage({ buffer: rtSig as unknown as ExcelJS.Buffer, extension: "png" }), { tl: { col: 1, row: 4 }, ext: { width: 120, height: 40 } });
  rt.getCell("B10").value = "RT DEMO  SIGNER, RRT";
  const pu = wb.addWorksheet("Pulmo Signature");
  pu.addImage(wb.addImage({ buffer: pulmoSig as unknown as ExcelJS.Buffer, extension: "png" }), { tl: { col: 1, row: 2 }, ext: { width: 120, height: 40 } });
  pu.getCell("C7").value = "Dr. Demo Pulmo Signer";
  return { bytes: Buffer.from(await wb.xlsx.writeBuffer()), logo, rtSig, pulmoSig };
}
