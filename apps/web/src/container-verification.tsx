import { useState } from "react";
export function ContainerVerificationFields({
  number,
  replacement,
}: {
  number: string;
  replacement?: string | null;
}) {
  const [current, setCurrent] = useState(""),
    [next, setNext] = useState("");
  return (
    <fieldset>
      <legend>Physical container confirmation</legend>
      <p>
        Check the number on the actual container. Assigned: {number}
        {replacement ? " · Exchange replacement: " + replacement : ""}. A
        mismatch requires dispatch review before completion.
      </p>
      <label>
        Physically verified container number
        <input
          aria-label="Physically verified container number"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          maxLength={80}
          required
        />
      </label>
      {replacement && (
        <label>
          Physically verified replacement number
          <input
            aria-label="Physically verified replacement number"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            maxLength={80}
            required
          />
        </label>
      )}
      <input
        type="hidden"
        name="container_verification"
        value={JSON.stringify({
          container_number: current.trim(),
          ...(replacement ? { replacement_container_number: next.trim() } : {}),
        })}
      />
      <label>
        <input type="checkbox" required />I checked these numbers on the
        physical equipment
      </label>
    </fieldset>
  );
}
