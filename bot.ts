import {
  Bot,
  type Context,
  InlineKeyboard,
  webhookCallback,
} from "https://deno.land/x/grammy@v1.34.0/mod.ts";
import { emoji } from "https://deno.land/x/grammy_emoji@v1.2.0/mod.ts";

const isDebug = !!Deno.env.get("DEBUG");
const kv = await Deno.openKv();

const welcomeMessage =
  "Hi! Glad to see that you want to join @grammyjs! Let me make sure that you are human.";

const empty = emoji("white_large_square");
function inputMessage(first = empty, second = empty, third = empty) {
  return `
Which emojis do you see in the slot machine? Please enter them using the buttons below!

${emoji("red_question_mark")}:  ${first}${second}${third}`;
}
function correctMessage(first: string, second: string, third: string) {
  return `
Correct! Welcome to @grammyjs, human!

${emoji("check_mark_button")}:  ${first}${second}${third}`;
}
function incorrectMessage(first: string, second: string, third: string) {
  return `
Incorrect. Are you sure that you are human?

${emoji("cross_mark")}:  ${first}${second}${third}`;
}

const helpTextPreRequest =
  "This bot protects the chat @grammyjs. You did not request to join it, so this bot does nothing for you right now.";
const helpInstructionStuck =
  "If you are completely stuck and you have no idea how to solve this captcha, feel free to open an issue on GitHub and tell us your Telegram username so we can add you to the chat. You can find the repository linked at the top of grammy.dev.";
const helpTextPostRequest = `
You have requested to join @grammyjs. We are happy to welcome you to the chat as soon as you have confirmed that you are human.

You can do this by sending me the three values that you see in the slot machine above. Simply tap three of the buttons above in the order that you see them.

(${helpInstructionStuck})`;
const helpTextPostFailure = `The slot machine ${
  emoji("slot_machine")
} above clearly displays three symbols. You need to press the respective buttons to enter the right code.

Note that the slot machine should be animated. If it does not display correctly, you need to disable power savings and try again. Alternatively, check this chat on a different device, such as your phone.

${helpInstructionStuck}`;
const thirtyMinutesInMilliseconds = 30 * 60 * 1000;

const em = [
  emoji("minus"),
  emoji("grapes"),
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
const keyboard = InlineKeyboard.from([em.map((e) => InlineKeyboard.text(e))])
  .toFlowed(2)
  .row().text(emoji("back_arrow"), "back");

const token = Deno.env.get("BOT_TOKEN") ?? "";
const me = Deno.env.get("BOT_INFO");
const bot = new Bot(token, {
  botInfo: me === undefined ? undefined : JSON.parse(me),
});
const safe = bot.errorBoundary((err) => {
  console.error(err);
});
const secretToken = bot.token.replaceAll(":", "_");

// disable the bot for all groups except @grammyjs
safe.on("my_chat_member")
  .chatType(["group", "supergroup", "channel"])
  .drop((ctx) => ctx.chat.username === "grammyjs")
  .use((ctx) => ctx.leaveChat());
// DM a dice to users upon join request
safe.on("chat_join_request", async (ctx) => {
  const dm = ctx.chatJoinRequest.user_chat_id;
  await ctx.api.sendMessage(dm, welcomeMessage);
  await sendCaptcha(ctx, dm, ctx.from.id);
});
interface Solution {
  code: number;
  created: number;
}
async function sendCaptcha(ctx: Context, chatId: number, userId: number) {
  const { dice } = await ctx.api.sendDice(chatId, emoji("slot_machine"));
  const { message_id } = await ctx.api.sendMessage(chatId, inputMessage(), {
    reply_markup: keyboard,
  });
  const solution: Solution = { code: dice.value, created: Date.now() };
  await kv.set(
    [chatId, "solution"],
    solution,
    // set expiry for the rare case that the queue task is not delivered
    { expireIn: 2 * thirtyMinutesInMilliseconds },
  );
  await kv.enqueue({ chatId, userId, messageId: message_id }, {
    delay: thirtyMinutesInMilliseconds,
  });
}
kv.listenQueue(async ({ chatId, userId, messageId }) => {
  const member = await bot.api.getChatMember("@grammyjs", userId);
  // only run if the member has not joined yet
  if (member.status !== "left") return;
  // only run if the captcha has not been solved yet
  const solution = await kv.get([chatId, "solution"]);
  if (solution.value === null) return;

  const retry = new InlineKeyboard()
    .url("Try again", "https://t.me/grammyjs");
  await kv.delete([chatId, "solution"]);
  await kv.delete([chatId, "input"]);
  await bot.api.editMessageText(
    chatId,
    messageId,
    "Your request has expired.",
    { reply_markup: retry },
  ).catch(console.error);
  await bot.api.declineChatJoinRequest("@grammyjs", userId)
    .catch(console.error);
});
// only respond in private chats
const dm = safe.chatType("private");
dm.on("callback_query:data").fork((ctx) => ctx.answerCallbackQuery());
dm.command("help", async (ctx) => {
  const dm = ctx.chatId;
  const solution = await kv.get([dm, "solution"]);
  await ctx.reply(
    solution.value === null ? helpTextPreRequest : helpTextPostRequest,
  );
});
dm.filter(() => isDebug).command(
  "test",
  (ctx) => sendCaptcha(ctx, ctx.chatId, ctx.from.id),
);
// disable bot for members and banned accounts
const captcha = dm.filter(async (ctx) => {
  if (isDebug) return true;
  const member = await ctx.api.getChatMember("@grammyjs", ctx.from.id);
  switch (member.status) {
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
// handle emoji input from inline keyboard
captcha.callbackQuery(em, async (ctx) => {
  const dm = ctx.chatId;
  const solution = await kv.get<Solution>([dm, "solution"]);
  if (solution.value === null) {
    await ctx.editMessageText(
      "The captcha has expired. You need to request to join @grammyjs again.",
      { reply_markup: undefined },
    );
    return;
  }

  const res = await kv.get<string[]>([dm, "input"]);
  const current = res.value ?? [];
  current.push(ctx.callbackQuery.data);
  if (current.length >= 3) {
    const [i0, i1, i2] = current;
    const [s0, s1, s2] = predictEmoji(solution.value.code);
    if (i0 === s0 && i1 === s1 && i2 === s2) {
      const duration = Date.now() - solution.value.created;
      const username = ctx.from.username === undefined
        ? ""
        : ` (https://t.me/${ctx.from.username})`;
      const user = `'${ctx.from.first_name}'${username}`;
      console.log(`Accepted ${user} who solved the captcha in ${duration} ms`);
      await ctx.editMessageText(correctMessage(i0, i1, i2), {
        reply_markup: undefined,
      });
      if (!isDebug) {
        await ctx.api.approveChatJoinRequest("@grammyjs", ctx.from.id);
      }
      await kv.delete([dm, "solution"]);
    } else {
      await ctx.editMessageText(incorrectMessage(i0, i1, i2), {
        reply_markup: new InlineKeyboard()
          .text("Try again", "again")
          .text(`I need help ${emoji("loudly_crying_face")}`, "help"),
      });
    }
    await kv.delete([dm, "input"]);
  } else {
    await ctx.editMessageText(inputMessage(...current), {
      reply_markup: keyboard,
    });
    await kv.set([dm, "input"], current, {
      expireIn: thirtyMinutesInMilliseconds,
    });
  }
});
// handle back button
captcha.callbackQuery("back", async (ctx) => {
  const dm = ctx.chatId;
  const solution = await kv.get<number>([dm, "solution"]);
  if (solution.value === null) {
    await ctx.editMessageText(
      "The captcha has expired. You need to request to join @grammyjs again.",
      { reply_markup: undefined },
    );
    return;
  }

  const res = await kv.get<string[]>([dm, "input"]);
  const current = res.value ?? [];
  if (current.length === 0) return;
  current.pop();
  await ctx.editMessageText(inputMessage(...current), {
    reply_markup: keyboard,
  });
  await kv.set([dm, "input"], current, {
    expireIn: thirtyMinutesInMilliseconds,
  });
});
// handle try again button
captcha.callbackQuery("again", async (ctx) => {
  await ctx.editMessageReplyMarkup();
  await sendCaptcha(ctx, ctx.chatId, ctx.from.id);
});
// handle failure help button
captcha.callbackQuery("help", async (ctx) => {
  await ctx.reply(helpTextPostFailure);
});
// handle any other updates
captcha.use(async (ctx) => {
  const dm = ctx.chatId;
  const solution = await kv.get<number>([dm, "solution"]);
  if (solution.value === null) {
    await ctx.reply(
      "Please request to join @grammyjs before messaging me.",
    );
    return;
  }
  await ctx.reply("Please use one of the provided buttons", {
    reply_markup: keyboard,
  });
});

if (isDebug) bot.start();
else Deno.serve(webhookCallback(bot, "std/http", { secretToken }));
