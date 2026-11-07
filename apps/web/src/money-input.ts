export function dollarsToCents(value: unknown) {
  const text = String(value ?? "");
  if (!/^[0-9]+(\.[0-9]{1,2})?$/.test(text))
    throw Error("Enter a dollar amount with up to two decimal places");
  const [dollars, fraction = ""] = text.split(".");
  const amount = Number(dollars) * 100 + Number(fraction.padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount > 100000000)
    throw Error("Amount exceeds the supported limit");
  return amount;
}
