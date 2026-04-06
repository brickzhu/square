# Chinese checkers star board (121 cells). 2-player: opposite star tips (diagonal
# / 对顶), 15 marbles each, win by filling opponent's home. 6-player: ten marbles
# per seat on six tip clusters; goal is opposite tip (+3 mod 6).

from __future__ import annotations

from functools import lru_cache

# yapf: disable
_END1 = frozenset({(-4, 4), (-3, 4), (0, 4), (-4, 7), (-2, 4), (-3, 7), (-1, 4), (-1, 5), (-4, 6), (-3, 6), (-2, 6), (-4, 5), (-3, 5), (-4, 8), (-2, 5)})
_END2 = frozenset({(6, -4), (4, 0), (4, -3), (7, -3), (5, -2), (5, -1), (6, -2), (4, -4), (5, -3), (6, -3), (7, -4), (8, -4), (4, -1), (4, -2), (5, -4)})
_END3 = frozenset({(-4, -2), (-4, -1), (-3, -2), (-3, -1), (-2, -2), (-4, -3), (-3, -3), (-4, 0), (-2, -3), (-1, -3), (0, -4), (-1, -4), (-4, -4), (-3, -4), (-2, -4)})
_START1 = frozenset({(3, -5), (1, -4), (4, -6), (1, -5), (4, -7), (2, -6), (4, -4), (3, -6), (0, -4), (4, -5), (3, -7), (2, -4), (4, -8), (3, -4), (2, -5)})
_START2 = frozenset({(-4, 4), (-5, 1), (-4, 1), (-5, 4), (-7, 4), (-6, 4), (-4, 0), (-5, 3), (-4, 3), (-5, 2), (-7, 3), (-4, 2), (-6, 3), (-8, 4), (-6, 2)})
_START3 = frozenset({(4, 4), (2, 4), (4, 0), (0, 4), (3, 4), (4, 1), (3, 1), (4, 3), (1, 4), (4, 2), (2, 3), (3, 3), (2, 2), (3, 2), (1, 3)})
_NEUTRAL = frozenset({(3, -2), (3, -1), (-3, 0), (-3, 3), (0, 2), (1, -3), (1, 0), (-2, -1), (-1, -2), (-1, -1), (-2, 1), (-1, 1), (3, -3), (3, 0), (-3, 2), (0, -1), (0, -2), (0, 1), (2, -2), (2, -1), (1, 2), (2, 1), (-2, 0), (-1, 0), (-2, 3), (-1, 3), (-2, 2), (0, -3), (-3, 1), (0, 0), (2, -3), (1, 1), (0, 3), (2, 0), (1, -2), (1, -1), (-1, 2)})  # noqa: E501
# yapf: enable

CHECKERS_STAR_ALL: frozenset[tuple[int, int]] = _END1 | _END2 | _END3 | _START1 | _START2 | _START3 | _NEUTRAL

CHECKERS_6_TIPS: tuple[tuple[int, int], ...] = (
    (-4, 8),
    (-8, 4),
    (-4, -4),
    (4, -8),
    (8, -4),
    (4, 4),
)


def _hex_dist_axial(a: tuple[int, int], b: tuple[int, int]) -> int:
    return (
        abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs((-a[0] - a[1]) - (-b[0] - b[1]))
    ) // 2


@lru_cache(maxsize=1)
def checkers_two_player_homes() -> tuple[frozenset[tuple[int, int]], frozenset[tuple[int, int]]]:
    """双人对顶：六角星上相对的两尖（索引相差 3），各 15 孔。座位 1 近尖 (4,-8)，座位 2 近尖 (-4,8)。"""
    tips = CHECKERS_6_TIPS
    idx_a, idx_b = 3, 0
    remaining: set[tuple[int, int]] = set(CHECKERS_STAR_ALL)
    homes: list[frozenset[tuple[int, int]]] = []
    for idx in (idx_a, idx_b):
        tip = tips[idx]
        ordered = sorted(
            remaining,
            key=lambda c: (_hex_dist_axial(c, tip), c[0], c[1]),
        )
        take = frozenset(ordered[:15])
        if len(take) != 15:
            raise RuntimeError("checkers 2p: could not carve 15 holes for a camp")
        remaining -= take
        homes.append(take)
    return homes[0], homes[1]


CHECKERS_P1_START, CHECKERS_P2_START = checkers_two_player_homes()
CHECKERS_P1_GOAL = CHECKERS_P2_START
CHECKERS_P2_GOAL = CHECKERS_P1_START


@lru_cache(maxsize=1)
def checkers_six_homes() -> tuple[frozenset[tuple[int, int]], ...]:
    """Six disjoint camps of 10 cells each; seat index 0..5 maps to seat 1..6."""
    remaining: set[tuple[int, int]] = set(CHECKERS_STAR_ALL)
    homes: list[frozenset[tuple[int, int]]] = []
    for tip in CHECKERS_6_TIPS:
        ordered = sorted(
            remaining,
            key=lambda c: (_hex_dist_axial(c, tip), c[0], c[1]),
        )
        take = frozenset(ordered[:10])
        if len(take) != 10:
            raise RuntimeError("checkers 6p: could not carve 10 holes for a camp")
        remaining -= take
        homes.append(take)
    return tuple(homes)


def checkers_six_goal_indices(seat_one_based: int) -> frozenset[tuple[int, int]]:
    """Seat 1..6 — target camp is the star tip opposite (+3 mod 6)."""
    if not 1 <= seat_one_based <= 6:
        raise ValueError("seat must be 1..6")
    homes = checkers_six_homes()
    idx = seat_one_based - 1
    return homes[(idx + 3) % 6]
