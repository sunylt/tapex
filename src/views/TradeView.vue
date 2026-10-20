<template>
  <main class="trade">
    <header class="trade__head">
      <h1 class="title">TAPEX 交易</h1>
      <p class="sub">交易功能开发中，敬请期待。</p>
    </header>

    <section class="placeholder">
      <p>Swap / 兑换入口将在这里上线。</p>
    </section>
  </main>
</template>

<style scoped>
.trade {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 0 56px;
}

.title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 6px;
  font-size: 26px;
  font-weight: 700;
  color: var(--color-heading);
}

.sub {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
}

.placeholder {
  padding: 32px 24px;
  border: 1px dashed var(--color-border-hover);
  border-radius: 14px;
  text-align: center;
  color: var(--color-text);
  opacity: 0.75;
}

.placeholder p {
  margin: 0;
  font-size: 14px;
}
</style>
