package world.brightos.bright_os_client.ota;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

final class BrightOtaVersion {
    private static final Pattern TOKEN_PATTERN = Pattern.compile("\\d+|[A-Za-z]+");

    private BrightOtaVersion() {}

    static int compare(String left, String right) {
        List<String> leftTokens = tokens(left);
        List<String> rightTokens = tokens(right);
        int count = Math.max(leftTokens.size(), rightTokens.size());
        for (int index = 0; index < count; index++) {
            String a = index < leftTokens.size() ? leftTokens.get(index) : "0";
            String b = index < rightTokens.size() ? rightTokens.get(index) : "0";
            int compared = compareToken(a, b);
            if (compared != 0) return compared;
        }
        return 0;
    }

    private static List<String> tokens(String version) {
        List<String> tokens = new ArrayList<>();
        Matcher matcher = TOKEN_PATTERN.matcher(version == null ? "" : version);
        while (matcher.find()) {
            tokens.add(matcher.group());
        }
        return tokens;
    }

    private static int compareToken(String left, String right) {
        boolean leftNumber = left.chars().allMatch(Character::isDigit);
        boolean rightNumber = right.chars().allMatch(Character::isDigit);
        if (leftNumber && rightNumber) {
            return new BigInteger(left).compareTo(new BigInteger(right));
        }
        if (leftNumber != rightNumber) {
            return leftNumber ? 1 : -1;
        }
        return left.toLowerCase(Locale.ROOT).compareTo(right.toLowerCase(Locale.ROOT));
    }
}
