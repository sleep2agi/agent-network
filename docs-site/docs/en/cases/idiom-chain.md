# Idiom Chain

Five Agents play a Chinese idiom chain game, demonstrating multi-Agent turn-based interaction.

**Estimated time**: 5 minutes  
**Number of Agents**: 5 (referee + 4 players)  
**Model**: MiniMax

## Result

```
裁判: "Idiom chain begins! First idiom: 一心一意"
选手1: "意气风发"
选手2: "发扬光大"
选手3: "大器晚成"
选手4: "成竹在胸"
选手1: "胸有成竹"
裁判: "Foul! '成竹在胸' and '胸有成竹' are duplicates! 选手1 is eliminated"
...
裁判: "选手3 wins!"
```

## Steps

### 1. Create Agents

```bash
# Referee
anet node create 裁判 --runtime claude-agent-sdk
# Select MiniMax

# 4 players
for i in 1 2 3 4; do
  anet node create 选手${i} --runtime claude-agent-sdk
  # Select MiniMax
done
```

### 2. Start

```bash
anet node start 裁判
for i in 1 2 3 4; do
  anet node start 选手${i}
done
```

### 3. Start the game

In the Dashboard ChatPanel, select `裁判` and send this Task:

```text
你是成语接龙的裁判。网络里有4个选手：选手1、选手2、选手3、选手4。规则：1）你说一个成语开头；2）按顺序让选手接龙；3）下一个成语的第一个字必须是上一个成语的最后一个字；4）接错或重复则出局；5）最后剩下的选手获胜。开始吧！
```

### 4. Watch the game

```bash
# Watch task flow in real time
anet tasks

# View the referee's orchestration logs
anet logs 裁判
```

## Architecture

```
              ┌──────┐
              │ 裁判  │
              └──┬───┘
                 │
    ┌────────┬───┴───┬────────┐
    ▼        ▼       ▼        ▼
┌──────┐┌──────┐┌──────┐┌──────┐
│选手1 ││选手2 ││选手3 ││选手4 │
└──────┘└──────┘└──────┘└──────┘
```

## Key points

- All using MiniMax: extremely low cost, sufficient Chinese idiom capability
- The referee orchestrates turn order, judges correctness, and announces results
- Demonstrates multi-round interaction between Agents

## Next steps

- [Telegram Squad](/en/cases/telegram-squad) -- Large-scale Docker orchestration
