import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export const embedColors = {
  printBench: 0x2bbf9c,
  pullRequest: 0x1b7fdb,
  issue: 0x1fa5c4,
  warning: 0xe0a158,
  danger: 0xe66c67,
};

export const printBenchLogo =
  "https://avatars.githubusercontent.com/u/319377697?v=4&s=128";

export function linkButtons(...links: [label: string, url: string][]) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    links.map(([label, url]) =>
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(label)
        .setURL(url),
    ),
  );
}
