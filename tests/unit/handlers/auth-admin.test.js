import {
  AdminAddUserToGroupCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ConfirmSignUpCommand,
  InitiateAuthCommand,
  ListUsersCommand,
  SignUpCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { listUsers, setUserRole } from '../../../src/handlers/admin.js';
import { confirm, login, refresh, register } from '../../../src/handlers/auth.js';
import { bodyOf, makeEvent, USERS } from '../helpers.js';

const cognitoMock = mockClient(CognitoIdentityProviderClient);

const cognitoError = (name, message = name) => Object.assign(new Error(message), { name });

beforeEach(() => {
  cognitoMock.reset();
});

describe('register', () => {
  const body = { email: 'nouveau@example.test', password: 'MotDePasse1!', name: 'Nouveau' };

  it("cree le compte et l'ajoute au groupe guest_author", async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'sub-1', UserConfirmed: false });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    const res = await register(makeEvent({ body }));
    expect(res.statusCode).toBe(201);
    expect(bodyOf(res)).toMatchObject({ userId: 'sub-1', confirmationRequired: true });
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input).toMatchObject({
      GroupName: 'guest_author',
      Username: 'sub-1',
    });
  });

  it("ne permet pas de choisir son role a l'inscription", async () => {
    const res = await register(makeEvent({ body: { ...body, role: 'admin' } }));
    expect(res.statusCode).toBe(400);
    expect(cognitoMock.commandCalls(SignUpCommand)).toHaveLength(0);
  });

  it("reussit meme si l'ajout au groupe echoue (role par defaut applique a la lecture)", async () => {
    cognitoMock.on(SignUpCommand).resolves({ UserSub: 'sub-1' });
    cognitoMock.on(AdminAddUserToGroupCommand).rejects(new Error('boom'));
    expect((await register(makeEvent({ body }))).statusCode).toBe(201);
  });

  it("409 si l'email existe deja, 400 si le mot de passe est refuse", async () => {
    cognitoMock.on(SignUpCommand).rejects(cognitoError('UsernameExistsException'));
    expect((await register(makeEvent({ body }))).statusCode).toBe(409);
    cognitoMock
      .on(SignUpCommand)
      .rejects(cognitoError('InvalidPasswordException', 'Password too weak'));
    expect((await register(makeEvent({ body }))).statusCode).toBe(400);
  });

  it('400 pour un corps invalide', async () => {
    expect((await register(makeEvent({ body: { email: 'x' } }))).statusCode).toBe(400);
  });
});

describe('confirm', () => {
  it('confirme le compte', async () => {
    cognitoMock.on(ConfirmSignUpCommand).resolves({});
    const res = await confirm(makeEvent({ body: { email: 'a@example.test', code: '123456' } }));
    expect(res.statusCode).toBe(200);
  });

  it('400 pour un code errone ou mal forme', async () => {
    cognitoMock.on(ConfirmSignUpCommand).rejects(cognitoError('CodeMismatchException'));
    expect(
      (await confirm(makeEvent({ body: { email: 'a@example.test', code: '123456' } }))).statusCode,
    ).toBe(400);
    expect(
      (await confirm(makeEvent({ body: { email: 'a@example.test', code: 'abc' } }))).statusCode,
    ).toBe(400);
  });
});

describe('login et refresh', () => {
  const credentials = { email: 'a@example.test', password: 'MotDePasse1!' };

  it('retourne les jetons', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: {
        IdToken: 'id',
        AccessToken: 'access',
        RefreshToken: 'refresh',
        ExpiresIn: 3600,
      },
    });
    const res = await login(makeEvent({ body: credentials }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      idToken: 'id',
      accessToken: 'access',
      refreshToken: 'refresh',
    });
  });

  it('401 pour de mauvais identifiants, 403 pour un compte non confirme', async () => {
    cognitoMock.on(InitiateAuthCommand).rejects(cognitoError('NotAuthorizedException'));
    expect((await login(makeEvent({ body: credentials }))).statusCode).toBe(401);
    cognitoMock.on(InitiateAuthCommand).rejects(cognitoError('UserNotConfirmedException'));
    expect((await login(makeEvent({ body: credentials }))).statusCode).toBe(403);
  });

  it('401 si Cognito demande un defi non supporte', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({ ChallengeName: 'NEW_PASSWORD_REQUIRED' });
    expect((await login(makeEvent({ body: credentials }))).statusCode).toBe(401);
  });

  it('refresh retourne de nouveaux jetons sans refreshToken', async () => {
    cognitoMock.on(InitiateAuthCommand).resolves({
      AuthenticationResult: { IdToken: 'id2', AccessToken: 'access2', ExpiresIn: 3600 },
    });
    const res = await refresh(makeEvent({ body: { refreshToken: 'x'.repeat(20) } }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).not.toHaveProperty('refreshToken');
  });
});

describe('listUsers', () => {
  it("reserve a l'admin", async () => {
    expect((await listUsers(makeEvent({}))).statusCode).toBe(401);
    expect((await listUsers(makeEvent({ user: USERS.editor }))).statusCode).toBe(403);
  });

  it('retourne les utilisateurs avec leur role', async () => {
    cognitoMock.on(ListUsersCommand).resolves({
      Users: [
        {
          Username: 'u1',
          UserStatus: 'CONFIRMED',
          Enabled: true,
          Attributes: [
            { Name: 'email', Value: 'u1@example.test' },
            { Name: 'name', Value: 'Un' },
          ],
        },
      ],
      PaginationToken: 'next',
    });
    cognitoMock.on(AdminListGroupsForUserCommand).resolves({ Groups: [{ GroupName: 'editor' }] });
    const res = await listUsers(makeEvent({ user: USERS.admin }));
    expect(res.statusCode).toBe(200);
    expect(bodyOf(res)).toMatchObject({
      items: [{ username: 'u1', email: 'u1@example.test', role: 'editor' }],
      nextToken: 'next',
    });
  });
});

describe('setUserRole', () => {
  const call = (user, body = { role: 'editor' }, username = 'cible') =>
    setUserRole(makeEvent({ user, params: { username }, body }));

  it('403 pour un editeur, 401 sans jeton', async () => {
    expect((await call(USERS.editor)).statusCode).toBe(403);
    expect((await call(undefined)).statusCode).toBe(401);
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)).toHaveLength(0);
  });

  it('ajoute le nouveau groupe puis retire les anciens', async () => {
    cognitoMock
      .on(AdminListGroupsForUserCommand)
      .resolves({ Groups: [{ GroupName: 'guest_author' }] });
    cognitoMock.on(AdminAddUserToGroupCommand).resolves({});
    cognitoMock.on(AdminRemoveUserFromGroupCommand).resolves({});
    const res = await call(USERS.admin);
    expect(res.statusCode).toBe(200);
    expect(cognitoMock.commandCalls(AdminAddUserToGroupCommand)[0].args[0].input.GroupName).toBe(
      'editor',
    );
    expect(
      cognitoMock.commandCalls(AdminRemoveUserFromGroupCommand)[0].args[0].input.GroupName,
    ).toBe('guest_author');
  });

  it("403 si l'admin change son propre role", async () => {
    const res = await call(USERS.admin, { role: 'guest_author' }, USERS.admin.id);
    expect(res.statusCode).toBe(403);
  });

  it('400 pour un role inconnu, 404 pour un utilisateur inconnu', async () => {
    expect((await call(USERS.admin, { role: 'root' })).statusCode).toBe(400);
    cognitoMock.on(AdminListGroupsForUserCommand).rejects(cognitoError('UserNotFoundException'));
    expect((await call(USERS.admin)).statusCode).toBe(404);
  });
});
