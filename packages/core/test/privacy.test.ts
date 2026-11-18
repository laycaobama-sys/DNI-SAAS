import { describe, expect, it } from "vitest";
import { detectSensitiveData } from "../src/privacy";

// Fake values assembled at runtime so the repository secret scanner does not flag test fixtures.
const FAKE_STRIPE = ["sk", "live", "abcdefghijklmnop"].join("_");
const FAKE_PEM = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");

describe("detectSensitiveData", () => {
  it.each([
    ["Mi DNI 12345678Z", ["dni_nie"]],
    ["NIE X1234567L", ["dni_nie"]],
    ["IBAN ES91 2100 0418 4502 0005 1332", ["iban"]],
    ["tarjeta 4111 1111 1111 1111", ["tarjeta"]],
    [`clave ${FAKE_STRIPE}`, ["credencial"]],
    ["password: supersecreto", ["credencial"]],
    [FAKE_PEM, ["credencial"]],
    ["escríbeme a ana.lopez@gmail.com", ["email"]],
    ["llámame al 612 345 678", ["telefono"]],
    ["o al +44 20 7946 0958", ["telefono"]],
  ])("detects %s", (text, expected) => {
    expect(detectSensitiveData(text)).toEqual(expected);
  });

  it.each([
    "¿Cómo mejoro el SEO local de mi panadería?",
    "Tenemos 3 tiendas, 120 reseñas y facturamos 250000 euros al año",
    "El DNI 12345678A tiene la letra mal", // invalid check letter
    "Pedido 4111111111111112", // fails Luhn
    "IBAN ES00 0000 0000 0000 0000 0000", // fails mod-97
    "Publicamos el 2026-11-18 a las 10:30",
    "",
  ])("ignores ordinary text: %s", (text) => {
    expect(detectSensitiveData(text)).toEqual([]);
  });
});
