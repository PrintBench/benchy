export class Actions<T> {
  private items = new Map<string, { action: T; expires: NodeJS.Timeout }>();

  add(id: string, action: T) {
    this.remove(id);
    const expires = setTimeout(() => this.items.delete(id), 5 * 60_000);
    expires.unref();
    this.items.set(id, { action, expires });
  }

  get(id: string) {
    return this.items.get(id)?.action;
  }

  remove(id: string) {
    const item = this.items.get(id);
    if (item) clearTimeout(item.expires);
    this.items.delete(id);
  }
}
