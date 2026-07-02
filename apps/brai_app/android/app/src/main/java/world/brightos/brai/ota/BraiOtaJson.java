package world.brightos.brai.ota;

import java.util.LinkedHashMap;
import java.util.Map;

final class BraiOtaJson {
    private final String input;
    private int index;

    private BraiOtaJson(String input) {
        this.input = input == null ? "" : input;
    }

    static Map<String, Object> parseObject(String json) throws BraiOtaException {
        BraiOtaJson parser = new BraiOtaJson(json);
        Map<String, Object> object = parser.readObject();
        parser.skipWhitespace();
        if (!parser.isAtEnd()) {
            throw new BraiOtaException("manifest_parse_failed");
        }
        return object;
    }

    private Map<String, Object> readObject() throws BraiOtaException {
        skipWhitespace();
        expect('{');
        Map<String, Object> object = new LinkedHashMap<>();
        skipWhitespace();
        if (consume('}')) return object;

        while (true) {
            skipWhitespace();
            String key = readString();
            skipWhitespace();
            expect(':');
            skipWhitespace();
            object.put(key, readValue());
            skipWhitespace();
            if (consume('}')) return object;
            expect(',');
        }
    }

    private Object readValue() throws BraiOtaException {
        skipWhitespace();
        char next = peek();
        if (next == '"') return readString();
        if (next == '-' || Character.isDigit(next)) return readNumber();
        if (consumeLiteral("true")) return Boolean.TRUE;
        if (consumeLiteral("false")) return Boolean.FALSE;
        if (consumeLiteral("null")) return null;
        throw new BraiOtaException("manifest_parse_failed");
    }

    private String readString() throws BraiOtaException {
        expect('"');
        StringBuilder builder = new StringBuilder();
        while (!isAtEnd()) {
            char value = input.charAt(index++);
            if (value == '"') return builder.toString();
            if (value != '\\') {
                builder.append(value);
                continue;
            }
            if (isAtEnd()) throw new BraiOtaException("manifest_parse_failed");
            char escaped = input.charAt(index++);
            switch (escaped) {
                case '"':
                case '\\':
                case '/':
                    builder.append(escaped);
                    break;
                case 'b':
                    builder.append('\b');
                    break;
                case 'f':
                    builder.append('\f');
                    break;
                case 'n':
                    builder.append('\n');
                    break;
                case 'r':
                    builder.append('\r');
                    break;
                case 't':
                    builder.append('\t');
                    break;
                case 'u':
                    builder.append(readUnicodeEscape());
                    break;
                default:
                    throw new BraiOtaException("manifest_parse_failed");
            }
        }
        throw new BraiOtaException("manifest_parse_failed");
    }

    private char readUnicodeEscape() throws BraiOtaException {
        if (index + 4 > input.length()) throw new BraiOtaException("manifest_parse_failed");
        String hex = input.substring(index, index + 4);
        index += 4;
        try {
            return (char) Integer.parseInt(hex, 16);
        } catch (NumberFormatException error) {
            throw new BraiOtaException("manifest_parse_failed", error);
        }
    }

    private Long readNumber() throws BraiOtaException {
        int start = index;
        if (peek() == '-') index++;
        while (!isAtEnd() && Character.isDigit(peek())) {
            index++;
        }
        try {
            return Long.parseLong(input.substring(start, index));
        } catch (NumberFormatException error) {
            throw new BraiOtaException("manifest_parse_failed", error);
        }
    }

    private void expect(char expected) throws BraiOtaException {
        if (!consume(expected)) throw new BraiOtaException("manifest_parse_failed");
    }

    private boolean consume(char expected) {
        if (!isAtEnd() && input.charAt(index) == expected) {
            index++;
            return true;
        }
        return false;
    }

    private boolean consumeLiteral(String literal) {
        if (input.startsWith(literal, index)) {
            index += literal.length();
            return true;
        }
        return false;
    }

    private char peek() throws BraiOtaException {
        if (isAtEnd()) throw new BraiOtaException("manifest_parse_failed");
        return input.charAt(index);
    }

    private void skipWhitespace() {
        while (!isAtEnd() && Character.isWhitespace(input.charAt(index))) {
            index++;
        }
    }

    private boolean isAtEnd() {
        return index >= input.length();
    }
}
