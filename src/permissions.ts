import { OverwriteType, PermissionFlagsBits } from "discord.js";

const { ViewChannel, ReadMessageHistory } = PermissionFlagsBits;

type Overwrite = {
  id: string;
  type: OverwriteType;
  allow: bigint;
  deny: bigint;
};

function entries(channel: {
  permissionOverwrites: {
    cache: Iterable<
      [
        string,
        {
          type: OverwriteType;
          allow: { bitfield: bigint };
          deny: { bitfield: bigint };
        },
      ]
    >;
  };
}): Overwrite[] {
  return Array.from(channel.permissionOverwrites.cache, ([id, entry]) => ({
    id,
    type: entry.type,
    allow: entry.allow.bitfield,
    deny: entry.deny.bitfield,
  }));
}
export { entries as channelOverwrites };

function everyoneHas(
  base: bigint,
  everyone: string,
  overwrites: Overwrite[],
  permission: bigint,
) {
  const common = overwrites.find(({ id }) => id === everyone);
  const effective = (base & ~(common?.deny ?? 0n)) | (common?.allow ?? 0n);
  return (
    Boolean(effective & permission) &&
    !overwrites.some(
      ({ id, deny }) => id !== everyone && Boolean(deny & permission),
    )
  );
}

function viewRules(overwrites: Overwrite[]) {
  return overwrites
    .filter(({ allow, deny }) => Boolean((allow | deny) & ViewChannel))
    .map(
      ({ id, type, allow }) => `${type}:${id}:${Boolean(allow & ViewChannel)}`,
    )
    .sort()
    .join(",");
}

export function coversSupportAudience(
  base: bigint,
  everyone: string,
  source: Overwrite[],
  forum: Overwrite[],
) {
  return (
    everyoneHas(base, everyone, source, ReadMessageHistory) &&
    (everyoneHas(base, everyone, source, ViewChannel) ||
      viewRules(source) === viewRules(forum))
  );
}

export function isRoleGated(
  everyone: string,
  overwrites: Overwrite[],
  allowedRoles: string[],
  requiredRole?: string,
) {
  return (
    overwrites.some(
      ({ id, deny }) => id === everyone && Boolean(deny & ViewChannel),
    ) &&
    overwrites.every(
      ({ id, type, allow }) =>
        !(allow & ViewChannel) ||
        (type === OverwriteType.Role && allowedRoles.includes(id)),
    ) &&
    (!requiredRole ||
      overwrites.some(
        ({ id, type, allow }) =>
          id === requiredRole &&
          type === OverwriteType.Role &&
          Boolean(allow & ViewChannel),
      ))
  );
}
