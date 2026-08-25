import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp } from "../src/api/clientIp.ts";

/** Минимум того, что clientIp читает из запроса. */
function request(socketAddress: string | undefined, forwarded?: string | string[]) {
  return {
    headers: forwarded === undefined ? {} : { "x-forwarded-for": forwarded },
    socket: { remoteAddress: socketAddress }
  };
}

test("без доверенных прокси берётся адрес сокета", () => {
  assert.equal(clientIp(request("203.0.113.9"), 0), "203.0.113.9");
});

test("без доверенных прокси заголовок игнорируется", () => {
  // Иначе кто угодно назначал бы себе новый адрес и обходил лимит.
  assert.equal(clientIp(request("203.0.113.9", "198.51.100.1"), 0), "203.0.113.9");
});

test("за одним доверенным прокси берётся правая запись", () => {
  assert.equal(clientIp(request("10.0.0.1", "198.51.100.1"), 1), "198.51.100.1");
});

test("подделанный клиентом заголовок не проходит", () => {
  // Клиент прислал «evil», прокси дописал справа настоящий адрес.
  // Левая запись — ложь, правая — то, что прокси видел своими глазами.
  const forged = "evil, 198.51.100.1";
  assert.equal(clientIp(request("10.0.0.1", forged), 1), "198.51.100.1");
});

test("за двумя доверенными прокси берётся вторая справа", () => {
  const chain = "198.51.100.1, 10.0.0.7";
  assert.equal(clientIp(request("10.0.0.1", chain), 2), "198.51.100.1");
});

test("заголовок короче цепочки доверия — возвращаемся к сокету", () => {
  // Запись отсутствует: доверять нечему, а ошибиться безопаснее в сторону
  // более строгого лимита, чем в сторону обхода.
  assert.equal(clientIp(request("10.0.0.1", "198.51.100.1"), 2), "10.0.0.1");
});

test("несколько заголовков склеиваются по порядку", () => {
  const split = ["evil", "198.51.100.1"];
  assert.equal(clientIp(request("10.0.0.1", split), 1), "198.51.100.1");
});

test("пробелы и пустые записи не сбивают счёт", () => {
  assert.equal(clientIp(request("10.0.0.1", "evil, ,  198.51.100.1  "), 1), "198.51.100.1");
});

test("без адреса сокета и без заголовка возвращается unknown", () => {
  assert.equal(clientIp(request(undefined), 0), "unknown");
});
