import {
    Bot,
    Keyboard,
    webhookCallback,
} from "https://deno.land/x/grammy@v1.30.0/mod.ts";
import { emoji } from "https://deno.land/x/grammy_emoji@v1.2.0/mod.ts";

const kv = await Deno.openKv();

const welcomeMessage =
    "Hi! Glad to see that you want to join @grammyjs! Let me make sure that you are human. Which emojis do you see?";
const thirtyMinutesInMilliseconds = 30 * 60 * 1000;

const em = [
    emoji("minus"),
    emoji("blueberries"),
    emoji("lemon"),
    emoji("keycap_digit_seven"),
];
function predictEmoji(value: number): [string, string, string] {
    const n = value - 1;
    return [
        em[(n & 0b000011) >> 0],
        em[(n & 0b001100) >> 2],
        em[(n & 0b110000) >> 4],
    ];
}
const keyboard = Keyboard.from([em.map(Keyboard.text)]).resized();

const bot = new Bot(Deno.env.get("BOT_TOKEN") ?? "");
const secretToken = bot.token.replaceAll(":", "_");

// disable the bot for all groups except @grammyjs
bot.on("my_chat_member")
    .chatType(["group", "supergroup", "channel"])
    .drop((ctx) => ctx.chat.username === "grammyjs")
    .use((ctx) => ctx.leaveChat());
// DM a dice to users upon join request
bot.on("chat_join_request", async (ctx) => {
    const dm = ctx.chatJoinRequest.user_chat_id;
    await ctx.api.sendMessage(dm, welcomeMessage);
    const message = await ctx.api.sendDice(dm, emoji("slot_machine"), {
        reply_markup: keyboard,
    });
    const value = message.dice.value;
    const kv = await Deno.openKv();
    await kv.set([dm, "solution"], value, {
        expireIn: thirtyMinutesInMilliseconds,
    });
});
// disable bot for members and banned accounts
const dm = bot.chatType("private").on(":text").filter(async (ctx) => {
    const chatMember = await ctx.api.getChatMember("@grammyjs", ctx.from.id);
    switch (chatMember.status) {
        case "administrator":
        case "creator":
            await ctx.reply("You are admin in @grammyjs already!");
            return false;
        case "kicked":
            await ctx.reply("You were banned from @grammyjs already!");
            return false;
        case "member":
        case "restricted":
            await ctx.reply("You are a member of @grammyjs already!");
            return false;
    }
    return true;
});
// handle emoji input from keyboard in DM
dm.hears(em, async (ctx) => {
    const dm = ctx.chatId;
    const solution = await kv.get<number>([dm, "solution"]);
    if (solution.value === null) {
        await ctx.reply(
            "Please request to join @grammyjs before sending any emoji to me.",
        );
        return;
    }

    const res = await kv.get<string[]>([dm, "input"]);
    const current = res.value ?? [];
    current.push(ctx.msg.text);
    if (current.length === 3) {
        const [i0, i1, i2] = current;
        const [s0, s1, s2] = predictEmoji(solution.value);
        if (i0 === s0 && i1 === s1 && i2 === s2) {
            await ctx.reply("Correct! Welcome to @grammyjs!");
            await ctx.api.approveChatJoinRequest("@grammyjs", ctx.from.id);
        } else {
            await ctx.reply(
                "Incorrect. Are you sure that you are human? Please try again.",
            );
            await kv.delete([dm, "input"]);
        }
    } else {
        await ctx.reply(`Current input: ${current.join("")}`);
        await kv.set([dm, "input"], current, {
            expireIn: thirtyMinutesInMilliseconds,
        });
    }
});
// handle any other updates
dm.use(async (ctx) => {
    const dm = ctx.chatId;
    const solution = await kv.get<number>([dm, "solution"]);
    if (solution.value === null) {
        await ctx.reply(
            "Please request to join @grammyjs before messaging me.",
        );
        return;
    }
    await ctx.reply("Please use one of the provided buttons");
});

if (Deno.env.get("DEBUG")) bot.start();
else Deno.serve(webhookCallback(bot, "std/http", { secretToken }));
